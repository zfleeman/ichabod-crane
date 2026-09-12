# OpenClaw and Pi

> **Superseded in one respect.** This memo's closing suggestion is a single scout pass under Pi with OpenClaw kept as the estate. The decision went further: OpenClaw goes entirely, and the board becomes Kanboard reached by a shell wrapper rather than by MCP — for exactly the preamble reason measured here. See [PI-MIGRATION.md](PI-MIGRATION.md). Everything about how the two harnesses actually work is unchanged.

A working memo from 2026-09-11, written as the companion to option C in [HARNESS-ALTERNATIVES.md](HARNESS-ALTERNATIVES.md). That memo asked whether Pi is worth trying. This one answers the mechanical question underneath it: if we did, what would actually happen on the box, minute by minute, and how does that differ from the way OpenClaw already drives a model with an API key?

The framing assumption, granted up front: Pi gets an OpenAI API key. That removes the subscription-auth unknown that option C stalls on, and it makes the comparison a fair one, because OpenClaw with an OpenAI API key is not hypothetical here. It is `mail_reader`, running today.

## The two layers everybody mixes up

OpenClaw keeps two things next to each other in config that are not the same thing, and almost every confusion in this memo comes from conflating them.

A **provider** is who you buy tokens from. It owns the key, the endpoint, and the price sheet. `openai` and `anthropic` are providers.

A **runtime** is who owns the agent loop — the code that assembles the context window, sends the request, receives tool calls, executes them, and decides whether to go around again. `openclaw` is a runtime. So is `claude-cli`, which is Claude Code wearing an OpenClaw adapter.

These are chosen separately, and the runtime is chosen per model. OpenClaw resolves it in this order: model-scoped policy, then provider-scoped policy, then auto-claim by a registered plugin, then a default of `openclaw`. That is why `scripts/configure-agents` sets `agents.entries.mail_reader.models["openai/gpt-5.4-nano"].agentRuntime.id` rather than setting a runtime for the agent as a whole — the mapping hangs off the model, not the agent.

The whole Pi question is a runtime question. Pi does not sell tokens; it is another candidate for "who owns the loop." And it is not a runtime OpenClaw knows about, which is the fact that shapes everything below.

## How OpenClaw normally uses an OpenAI API key

This is `mail_reader`, and the two lines that create it are `scripts/configure-agents:105-106`:

```
model  = {"primary":"openai/gpt-5.4-nano","fallbacks":[]}
models = {"openai/gpt-5.4-nano":{"agentRuntime":{"id":"openclaw"}}}
```

Here is what happens when an email arrives, in order.

1. **The trigger fires.** The IMAP plugin polls, finds a message that passes the DMARC gate, and asks the Gateway to dispatch a turn to `mail_reader`.
2. **OpenClaw builds the context window.** Its own generated system prompt, plus the workspace files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`) from `workspace-mail-reader`, plus JSON schemas for the effective tool set. "Effective" is doing real work in that sentence: the agent-layer policy (`profile: minimal`, `alsoAllow`, `deny`) is intersected with the sandbox's own allow list, and what survives is what gets a schema. For `mail_reader` that is `session_status` and `workboard_create`, which is why its preamble is small.
3. **OpenClaw resolves the key and makes the call.** The OpenAI key lives in the secret store and is referenced from config as a SecretRef. It is resolved inside the Gateway process, immediately before the HTTPS request, and goes into an `Authorization` header on an outbound call to OpenAI. It is never a tool parameter, never in the prompt, never in argv. That is the property `docs/ICHABOD-GUIDE.md` is protecting when it says SecretRefs keep values out of model context.
4. **The response comes back with tool calls, and OpenClaw executes them.** Inside the sandbox. Through the plugin hook chain — `triage-guard` is a `before_tool_call` hook, and it is at this exact point that it strips `agentId` off the card. Then OpenClaw loops: new tool results appended, next request sent.
5. **The turn finishes and OpenClaw records it.** Session record, token accounting, run history, workboard event.

The property to hold onto: **OpenClaw is holding the loop the entire time**, so every OpenClaw feature is live. Sandbox, tool policy, hooks, secret resolution, the session ledger, the model fallback chain. They all work because OpenClaw is the thing between the model and the machine.

There is a second OpenAI shape worth naming, because it is the one Pi resembles. If you give an agent an OpenAI model and *don't* pin the runtime, OpenClaw hands the loop to the Codex CLI harness instead. The key is then Codex's problem, the tools are Codex's tools, the process runs as the host user, and OpenClaw's `sandbox.mode` and `deny` lists are declarations that nothing enforces. `docs/ICHABOD-GUIDE.md:770` is about exactly this, and it is the single most important line in that document because it fails silently — `sandbox explain` still prints `runtime: sandboxed`.

## How OpenClaw would use Pi

Start from the constraint: **OpenClaw cannot call Pi the way it calls OpenAI.** Pi is not a provider, and it is not a runtime OpenClaw has a plugin for. There is no config line that makes `pi` a value of `agentRuntime.id`. Whatever we build, OpenClaw's relationship to Pi is "a process I start and wait for," not "a model I call."

That is less of a downgrade than it sounds, because starting processes on a schedule is something OpenClaw is good at, and it is most of what we use it for.

Three shapes are possible. They are ordered by how much has to be true for them to work.

### Shape 1 — a scheduled subprocess

`openclaw automations add` takes `--script` as an alternative to `--message`. A `--message` job sends text to an agent and OpenClaw runs the loop. A `--script` job runs a command on the box and OpenClaw runs nothing but the clock.

So the director-on-Pi job is a scheduler entry pointing at a wrapper script, and the wrapper invokes `pi -p`. OpenClaw's role collapses to cron-with-run-history. Pi's role expands to everything else.

This is the shape to spike, and it has an unadvertised benefit. `automations/README.md` documents a real trap: a `--message` job holds a *copy* of the prompt, baked in at registration, so the file in the repo and the text in the job drift apart silently and `configure-automations` erases live edits with no diff. A `--script` job holds a path. The prompt is read off disk at run time, so `make sync` shipping the file *is* the deploy, and the two-places problem goes away.

### Shape 2 — Pi as a tool of the existing agent

Leave the passes exactly as they are and let `ichabod` shell out to `pi -p` for a bounded subtask, the same way he shells out to `gh` or `docker`. He is already unsandboxed with a real `Bash`, so this needs no configuration at all.

It is the cheapest thing on the list to try and it is worth trying, but be clear about what it buys: it does not touch the director's preamble, because the director is still a claude-cli session carrying all 38,831 tokens before it starts. It buys a cheap second opinion on a narrow job, not a cheaper loop.

### Shape 3 — ACP

OpenClaw's runtime docs describe external harnesses reached over ACP (the Agent Client Protocol — JSON-RPC over stdio, backed by Zed, covering session lifecycle, tool calls, permission requests, and streaming). Pi has no first-party ACP support, but there is a community adapter, `pi-acp`, that embeds Pi through its SDK and exposes it as an ACP agent, and Pi is listed on Zed's ACP agent page.

If that adapter satisfies what OpenClaw's `acpx` path expects, this is the integration with the highest ceiling: streaming, per-call permissions, real session lifecycle, rather than a process that prints text and exits. It is also entirely unverified from here, and it puts a third-party adapter in the path of the operating loop. Not first.

## A director pass on Pi, end to end

The thing worth walking through concretely. This is shape 1, written out.

**On the box, once:** `pi` is installed, and `/srv/ichabod/bin/pi-pass` exists as the wrapper. The prompt files ship where they already ship, `/srv/ichabod/automations/director.md`. The OpenAI key is read out of the secret store by the wrapper at run time rather than baked into anything on disk.

**The wrapper**, roughly:

```bash
#!/usr/bin/env bash
# Run one pass under Pi. $1 is the prompt file basename, e.g. "director".
set -euo pipefail
export OPENAI_API_KEY="$(openclaw secrets get OPENAI_API_KEY --raw)"
cd /home/openclaw/.openclaw/workspace
exec pi -p --model openai/gpt-5.4 \
  --tools read,write,edit,bash \
  --no-session \
  @"/srv/ichabod/automations/$1.md"
```

**The registration**, replacing the `--message` form:

```bash
oc automations add --name director --display-name "Director pass" \
  --session isolated --every 1h \
  --script "/srv/ichabod/bin/pi-pass director" \
  --timeout-seconds 1800 --no-deliver
```

**What happens when it fires:**

1. The Gateway's scheduler reaches the job and spawns the wrapper as the `openclaw` user. No model call has happened yet, and none will happen inside OpenClaw at all.
2. The wrapper resolves the key into its own environment and execs `pi`.
3. Pi builds its context window: its own short system prompt, the workspace `AGENTS.md` (which it reads natively — it looks for `AGENTS.md` and `CLAUDE.md` walking up from the working directory, concatenating what it finds), schemas for the four tools we allowlisted, and the director prompt as the user message. This is the whole preamble. There is no server-delivered system prompt, because there is no CLI backend, and no MCP bridge, because there is no bridge.
4. Pi calls OpenAI directly with its own key and runs its own tool loop. Its `bash` is **synchronous** — the command runs, the output comes back in the same tool result. That matters more than it sounds: the documented failure of option B was 14 turns of sleep-and-poll against OpenClaw's async `exec`, and the director prompt is written in `&&`-chained shell against a synchronous tool.
5. Board access happens through that shell, exactly as it does today. `openclaw workboard list --json | python3 -c ...` is a shell pipeline in the current prompt already, and it works identically under Pi because the `openclaw` CLI talks to the Gateway over loopback. The pass reads the board, triages, dispatches, and appends its journal entry with `write`.
6. Pi prints the final assistant message to stdout and exits. The wrapper's exit code is the job's result.
7. OpenClaw records that a script job ran and what it exited with. It does **not** record a session, a turn count, or a token total, because from its point of view a process ran.

The dispatched work still lands on `ichabod` through the board, on claude-cli, on the subscription. Only the routing pass moved. That is the point — the director is the pass that runs constantly and builds nothing, so it is where a cheap harness pays and a capable one is wasted.

## The two key stories, side by side

| | OpenClaw runtime + OpenAI key | Pi + OpenAI key |
|---|---|---|
| Where the key is configured | SecretRef in `openclaw.json`, value in the secret store | Env var on a subprocess, resolved by a wrapper at run time |
| Who reads it | The Gateway process, immediately before the HTTPS call | The `pi` process, for the life of the pass |
| Where it is exposed | An `Authorization` header | Also `/proc/<pid>/environ`, readable by the same user |
| In model context? | No | No |
| Rotation | Store the new value, `secrets reload` | Same, if the wrapper reads the store; a hardcoded key is a second place to forget |
| What the key can spend | One nano-priced call per email | A full routing pass, every hour, forever |

Both live on a root-equivalent box, so the ceiling on a real compromise is identical and neither approach changes it. The difference is casual exposure and blast radius, and blast radius is the honest concern: the key on the box today is scoped to a membrane that reads one email at a time with a nano model. Handing the same key to the heaviest recurring pass on the box changes what a leak costs, and it changes the bill even when nothing leaks.

One quiet side effect: Pi auto-saves every session as JSONL under `~/.pi/agent/sessions/`, organized by working directory. That is a second transcript store, holding the same board contents and journal text as OpenClaw's, outside `openclaw backup create` and outside anything we currently rotate. Either add it to the backup path or pass `--no-session`, but decide on purpose.

## What you give up the moment the loop leaves OpenClaw

The rule at `ICHABOD-GUIDE.md:770` was written about `claude-cli` and the Codex harness, but it is not about those two products. It is about any runtime that is not OpenClaw's, and **Pi is one of those**. Everything OpenClaw does between the model and the machine stops:

- **The sandbox.** `sandbox.mode` and `workspaceAccess` describe nothing Pi obeys.
- **Tool policy.** `profile`, `allow`, `alsoAllow`, `deny` are not consulted. Pi's `--tools` allowlist is the only tool policy there is.
- **Plugin hooks.** No `before_tool_call`, so no `triage-guard`.
- **The session ledger.** No session record, no token accounting, no per-pass usage in `openclaw` history.
- **The model fallback chain.** Pi has its own retry behaviour and OpenClaw's `fallbacks` list is not it.

The consequence worth stating plainly: **Pi can never host `mail_reader`.** The membrane exists because OpenClaw owns that loop, and a Pi-shaped `mail_reader` is an unsandboxed process with a shell reading attacker-controlled text. Pi is only a candidate for the `ichabod`-side passes, which are unsandboxed by design and already run with full host authority. Everything in this memo is scoped to those.

## What you gain

- **Preamble.** ~3,500 estimated against 38,831 measured. Unverified on our workload, and the number that the whole spike exists to produce.
- **A synchronous shell**, which is the specific thing option B fails on and the reason Pi beats OpenClaw's own embedded runtime for this job despite both dropping claude-cli.
- **Prompt files we already maintain.** Pi reads `AGENTS.md` and `CLAUDE.md` natively, and takes `@file` arguments, so `director.md` ships as-is.
- **An allowlist that is actually an allowlist.** `--tools read,write,edit,bash` is four schemas, not a filter over a large default set.
- **Reversibility.** The unit of change is one scheduler entry. Reverting is one `configure-automations` run.

## Cost, which is the decision

Today `ichabod` costs rate-limit bucket, not dollars, because claude-cli runs on the Pro subscription. `mail_reader` costs dollars, but they round to nothing — a nano model on one email.

Moving the director to Pi moves the busiest pass on the box from the first currency to the second. The arithmetic is genuinely favourable on preamble alone — a pass that carries ~3,500 tokens instead of 38,831 pays about a tenth of the fixed cost per turn — but preamble is only the fixed part, and once it is small the bill is dominated by the work: board projections, journal writes, and whatever the pass reads. Nobody has measured that half on Pi, so **do not put a monthly figure on this before running one pass.** Pi's `--mode json` emits usage events; the first spike should capture them, and that number is the one that decides whether the director follows.

The honest framing: this is not a cost reduction, it is a currency swap plus a large efficiency gain, and whether the swap is worth it depends on a number we do not have.

## Gotchas to design against

Most of these are the same traps this repo has already paid for once, in a new hat.

- **Run as `openclaw` with `HOME` set, not through `sudo -iu`.** The `-i` login shell re-parses the command line, and `director.md` is full of backticks. `configure-automations` already carries this scar — a prompt passed through `-iu` executed its own backticks and baked the whole board into a job.
- **Make failure loud.** A `--script` job that dies at line 2 and a pass with nothing to do look identical from the run history. Same lesson as the trigger-script note in `automations/README.md`, and the same lesson as the heartbeat that skipped forty times unnoticed.
- **Kill Pi when the job times out.** `--timeout-seconds` bounds the wrapper; make sure the child dies with it rather than orphaning a process that keeps spending.
- **Decide about sessions explicitly.** `--no-session` for an isolated pass that reads the board fresh every time, matching what the passes do today. Anything else grows a transcript directory nothing prunes.
- **Read the key from the store, never from a file.** The wrapper is on disk and in git-adjacent paths; the key should not be either.
- **Re-verify the tool list after any Pi upgrade,** for the same reason `configure-agents` warns about run-level tool caps: an allowlist that silently changes meaning is how the 14-turn `exec` failure happened.

## Recommended first experiment

Deliberately small, and not the director.

1. **Install Pi and run `scout` under it**, on a manual invocation, not a schedule. Scout is the simplest pass and the cheapest thing to break.
2. **Capture the preamble.** `--mode json`, read the first usage event, compare against 38,831. This is the only number that matters and it takes one run to get.
3. **Check the board round-trip.** Confirm `openclaw workboard create` works from inside Pi's `bash` as the `openclaw` user. If it does not, everything above is theory.
4. **Only then register it as a `--script` job**, on the scout's existing cadence, and let it run for a day next to the untouched director.
5. **Decide about the director from that data**, not from this memo.

Acceptance for the spike: a measured preamble, a card the pass created, and a day of run history with no silent failures. If any of the three is missing, the answer is no and the revert is one command.

## Open questions

- Does OpenClaw's run history surface a `--script` job's stdout and exit code usefully, or only "ran"? Unverified, and it decides how much logging the wrapper has to do itself.
- Does `pi-acp` satisfy what OpenClaw's `acpx` path expects? Entirely unknown, and the answer decides whether shape 3 is ever worth revisiting.
- What is Pi's real preamble on our workload? Estimated, never measured.
- Is a full-size OpenAI key spend on the box acceptable, given it currently holds one scoped to a nano-model membrane?

## Sources

Live-box details are read from `scripts/configure-agents`, `scripts/configure-automations`, `automations/README.md` and `docs/ICHABOD-GUIDE.md` in this repo. Preamble and cost figures come from [HARNESS-ALTERNATIVES.md](HARNESS-ALTERNATIVES.md). Pi and OpenClaw behaviour is from vendor documentation and has not been run on this box.

- [OpenClaw agent runtimes](https://docs.openclaw.ai/concepts/agent-runtimes), [model providers](https://docs.openclaw.ai/concepts/model-providers), [CLI backends](https://docs.openclaw.ai/gateway/cli-backends), [secrets](https://docs.openclaw.ai/gateway/secrets)
- [Pi Coding Agent](https://pi.dev/) and its [README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md), [SDK docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi CLI, session tree and RPC cheatsheet](https://aiidelist.com/pi-coding-agent-cheatsheet), [run modes and session trees](https://www.developersdigest.tech/blog/pi-hands-on-run-modes-session-trees-guide)
- [ACP support discussion for Pi](https://github.com/earendil-works/pi/discussions/4444), [pi-acp adapter](https://github.com/victor-software-house/pi-acp), [Pi on Zed's ACP agent list](https://zed.dev/acp/agent/pi)
