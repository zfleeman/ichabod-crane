# Migrating off OpenClaw

The plan for replacing OpenClaw with Pi and cron, written 2026-09-11 after a day of measuring where the tokens went.

The goal is a box you can hold in your head: a handful of shell scripts, a crontab, prompt files, and `pi`. No Gateway, no TypeScript plugins, no `openclaw.json`, no Control UI. That moves us most of the way toward Rohrer's clone kit — deliberately, and with one exception.

## Why

Measured on the live box on 2026-09-11, from the transcripts' `prompt_snapshot` records. The director pass carried **38,831 tokens** before its first action, after two rounds of trimming from 61,122:

| Component | Tokens |
|---|---|
| Anthropic's server-delivered Claude Code system prompt | ~12,700 |
| Tool schemas: 6 native Claude Code tools + 14 OpenClaw tools bridged over MCP | ~16,800 |
| Our prompt, `AGENTS.md`, and harness framing | ~9,300 |

A third of that is not ours to control — the server prompt more than doubled overnight with no change on our side — and most of the rest is three tool surfaces stacked on one agent. Pi's pitch is the opposite: four tools and a system prompt under 1,000 tokens, with an estimated preamble around 3,500. That estimate has never been measured on our workload, which is the first thing to do before merging.

The new stack runs on OpenAI models through a ChatGPT Plus subscription, logged in with Pi. The bill is flat, so the constraint becomes the subscription's usage limits. Two findings from that measurement still apply:

- **A smaller preamble stretches the allowance.** Every turn re-sends the preamble, so the tokens it carries are paid out of the same usage window as the real work.
- **Model by job.** A pass that routes and writes runs on a mid-tier model; a dispatched worker that builds gets the strongest one. The smallest tier was rejected for routing because triage is a judgment call on attacker-influenced text, and it fails destructively.

## Decisions already taken

Settled, so the build list below reads as work rather than as options. The reasoning for each is in the section it belongs to.

| Decision | Where |
|---|---|
| Pi plus cron replaces OpenClaw entirely | this document |
| The board is Kanboard, home-hosted on Zach's Synology, at `ichabod-board.zfleeman.com` | [The board](#the-board) |
| The agent reaches the board through a `board` shell wrapper, **not** MCP | [The board](#the-board) |
| The mail membrane keeps its boundary, rebuilt around a tool-less reader | [MEMBRANE.md](MEMBRANE.md) |
| The membrane runs as `ichabod`, not as a user of its own | [MEMBRANE.md](MEMBRANE.md) |
| The OpenClaw instance is destroyed outright and a fresh one built from `tofu/`. Nothing on it is kept, and the two stacks never run side by side | [Teardown](#teardown) |

Still open: which OpenAI models fill each job, and whether a Plus allowance covers the crontab and the dispatched workers. Answer both before merging.

## The one thing that must not regress

The exception is the trust boundary. The README says it plainly: **the kit optimizes for never stopping, and this project optimizes for never trusting the input.** Simplifying the machinery is the whole point of this migration; dropping the membrane is not part of it, and a version of this plan that quietly loses it is a failure even if every pass runs.

The good news is that it should get *stronger*. Every sandbox failure this project has recorded was the same shape: config declared a boundary that nothing enforced, and the tool that reports on it lied. `sandbox explain` printed `runtime: sandboxed` for a reader that had a shell, Docker, and the network. Under Pi the membrane stops being a config assertion and becomes a process one — started with no tools and an empty environment. That is a claim you verify by trying to break it, which is the only kind of verification this project has found reliable.

## Target architecture

One box, one Unix user, six scripts, one crontab.

```
/home/ichabod/
  bin/
    run-pass      run one prompt file under pi, with a lock and a timeout
    board         one curl per Kanboard JSON-RPC method, the agent's only board access
    intake        fetch mail -> membrane -> card
    notify        send one email
    health        touch on success; shout when stale
    usage         the ChatGPT Plus 5-hour and weekly usage, as one JSON line
  prompts/
    route.md  work.md  scout.md  digest.md  membrane.md
  workspace/      AGENTS.md, IDENTITY.md, SOUL.md, USER.md, MEMORY.md, memory/, skills/
  log/            YYYY-MM-DD/HHMM-<pass>.jsonl, one per run
  .config/ichabod/env  0600, tokens and passwords, sourced by the wrappers
```

`ichabod` runs every pass, every worker, and the membrane wrapper, and holds Docker, `gh`, the ChatGPT login and the mailbox. The membrane runs as `ichabod` rather than as a user of its own — see [MEMBRANE.md](MEMBRANE.md#what-we-deliberately-gave-up) for what that costs and how the isolation is kept anyway.

The crontab, as a starting shape:

```cron
*/5  * * * *  /home/ichabod/bin/intake
*/15 * * * *  /home/ichabod/bin/usage >> /home/ichabod/log/usage.jsonl
*/15 * * * *  /home/ichabod/bin/run-pass route
*/15 * * * *  /home/ichabod/bin/run-pass work
0 4,11,18 * * *  /home/ichabod/bin/run-pass scout
0 7  * * *    /home/ichabod/bin/run-pass digest
```

`run-pass` is the whole harness. Roughly:

```bash
#!/usr/bin/env bash
set -euo pipefail
name="$1"
set -a; . /home/ichabod/.config/ichabod/env; set +a
day="$(date +%F)"; out="/home/ichabod/log/$day/$(date +%H%M)-$name.jsonl"
mkdir -p "/home/ichabod/log/$day" /home/ichabod/.local/state

rc=0
flock -n "/home/ichabod/.local/state/$name.lock" \
  timeout 1800 \
  pi --mode json --tools read,write,edit,bash --no-session \
     -C /home/ichabod/workspace \
     @"/home/ichabod/prompts/$name.md" > "$out" || rc=$?

# The number this whole migration is about, one line per pass. Field names are
# a guess until someone reads a real event; do not trust this jq as written.
jq -s '[.[] | .usage // empty] | {pass: "'"$name"'",
       in: (map(.input_tokens) | add), out: (map(.output_tokens) | add)}' \
  "$out" >> /home/ichabod/log/cost.jsonl
exit $rc
```

`flock -n` is the concurrency rule that `--max-starts 1` enforces today: if the previous run is still going, this one exits rather than stacking. `timeout` is the stall recovery that "a `running` card that has not moved in over an hour is stuck" currently handles by hand. `rc` is captured rather than allowed to abort under `set -e`, because a failed pass still has a log worth summarising.

Two small follow-ups on the lock. A skipped run exits 1 and leaves an empty log, so `health` cannot tell it from a failure; `flock -n -E 75` and an early clean exit on 75 fixes that. And `intake` should take its own `intake.lock`, so a slow membrane call cannot overlap the next five-minute run and pick up the same message twice.

### Measuring usage

The subscription's limits show on chatgpt.com, which nothing on the box can read. Two numbers stand in for it:

- **Tokens per run**, from Pi's own events into `log/cost.jsonl` above. This is how hard each run worked.
- **Percent of the allowance used**, from `usage`, into `log/usage.jsonl` every fifteen minutes. This is how much room is left.

`usage` asks the endpoint that the Pi extensions [`pi-codex-rate-limits`](https://github.com/scnewma/pi-codex-rate-limits) and [`pi-codex-limit`](https://pi.dev/packages/pi-codex-limit) call, with the same login Pi uses:

```bash
#!/usr/bin/env bash
# usage   one JSON line: 5-hour and weekly percent used, and when the week resets
set -euo pipefail
# The auth.json key names are a guess; check them with `jq keys` before trusting this.
token="$(jq -r '."openai-codex".access' /home/ichabod/.pi/agent/auth.json)"
curl -sS --fail -H "Authorization: Bearer $token" https://chatgpt.com/backend-api/wham/usage |
  jq -c '{at: (now | todate), limit_reached: .rate_limit.limit_reached,
          five_hour: .rate_limit.primary_window.used_percent,
          weekly: .rate_limit.secondary_window.used_percent,
          weekly_resets: (.rate_limit.secondary_window.reset_at | todate)}'
```

The digest reports from both files, and `route` can run `usage` before dispatching self-directed work and hold off above a weekly threshold Zach picks. The endpoint is undocumented, so it can change without notice; `--fail` makes that an error `health` can see rather than a quiet gap in the log. The token Pi saves expires and Pi refreshes it only when it runs, so after a long idle stretch `usage` can fail once until the next pass.

### Which run mode, and why

Pi has four: interactive, print (`-p`), JSON (`--mode json`), and RPC (`--mode rpc`). Two of them are used here.

**Passes use `--mode json`.** `-p` prints the final assistant message and nothing else — no token counts, no record of which tools were called. The whole point of this migration is a token number, so a mode that does not emit one leaves us blind in the exact place we are trying to see. JSON mode also means the log file and the event stream are the same artifact, so there is no separate logging to write, and a pass killed by `timeout` still leaves everything up to the kill rather than nothing.

**The membrane uses `-p`.** Its contract is four fields of JSON validated by the wrapper. Under `--mode json` the wrapper would have to pull the assistant text out of an event envelope and then parse that — two parsers on the one path where hostile input arrives, which is the wrong place to add surface. Its token usage does not need measuring either. One trap to handle in `intake`: models commonly wrap JSON output in Markdown fences, so strip fences before parsing rather than assuming a bare object.

**Nothing uses RPC.** RPC holds a live session and exposes `prompt`, `steer`, `follow_up`, `abort` and `get_state` over line-delimited JSON on stdin. That is for an orchestrator that wants to intervene mid-turn. Our passes are fire-and-forget — cron starts them, they finish or time out, and there is nothing to steer. Adopting it means writing a client that owns process lifecycle and framing, which is a daemon, which is the category of machinery we are removing OpenClaw to be rid of. It becomes worth revisiting only if a pass needs to be interruptible, or if `route` and `work` collapse into one long-lived loop — a question for later.

**Verify the flag spelling before building on it.** An earlier draft of this document wrote `pi -p --mode json`. That is probably invalid, since `-p` is very likely shorthand for `--mode print`, in which case the two contradict and one wins silently. Confirm which before the wrapper is built on it.

**Traps the old stack already paid for, in new hats:**

- **Never pass a prompt through `sudo -iu`.** The `-i` login shell re-parses the command line, so a Markdown prompt has its backticks executed on the box. It happened once: a prompt ran `openclaw workboard dispatch` and baked the whole board into a job. Cron running as `ichabod` avoids `sudo` entirely; keep it that way.
- **Make failure loud.** A pass that dies at line 2 and a pass with nothing to do look identical from outside. A stock heartbeat job once failed forty runs in a row unnoticed. That is what `health` is for, and it must shout when its own check breaks rather than go quiet.
- **Make sure `timeout` kills Pi's children too.** `timeout` signals its direct child. A `bash` tool call that outlives it keeps running, and a runaway one keeps spending. Check this before merging and add `--kill-after` or a process-group kill if needed.
- **Re-check the tool list after every Pi upgrade.** An allowlist that silently changes meaning is how OpenClaw's narrowed tool list swapped synchronous `Bash` for an async `exec` and a pass spent 14 turns in a sleep-and-poll loop.

**Keep `route` and `work` separate at first, even though collapsing them is tempting.** `route.md` is `director.md` with the workboard commands swapped out, and that prompt is battle-tested — eight numbered steps refined against real failures. `work.md` is new. Merging them into one "read the board, do the next thing" loop is the genuinely Sammy-shaped end state and is probably right eventually, but it changes two things at once. Do it as a later simplification, once the substrate is proven, and do it because the separation turned out not to earn its keep rather than on principle.

## What replaces what

| OpenClaw provides | Replacement | Confidence |
|---|---|---|
| Scheduler (`automations`) | cron + `flock` + `timeout` | High. This is cron's actual job |
| Agent loop, context assembly | `pi --mode json` | High, pending a measured pass |
| Workboard | Kanboard, reached by a `board` shell wrapper over JSON-RPC | High. The API is plain HTTP |
| `triage-guard` hook | The membrane's wrapper — it parses Pi's output and writes the card itself | High. Stronger than a hook |
| Sandbox for `mail_reader` | Pi started with no tools, under `env -i` | High, and testable |
| IMAP intake plugin | ~40 lines of Python `imaplib` in `intake` | High. The gate's rules are in [MEMBRANE.md](MEMBRANE.md#step-1--fetch) |
| `smtp-send` plugin | ~20 lines of Python `smtplib` in `notify` | High. Keep its rules: Zach is the only recipient, enforced in code; envelope sender and `From` both `ichabod@ichabod-crane.net`; retry `4xx`, stop on `5xx`; a per-hour send cap as a retry-loop backstop; the password redacted out of any error text |
| `mailbox` plugin (search/archive) | The same script, more subcommands | High |
| SecretRefs + secret store | `/home/ichabod/.config/ichabod/env`, mode 0600 | High, and honest — see below |
| Session ledger, token accounting | Pi's `--mode json` events, one file per run in `log/` | High. Better for forensics than today |
| `backup create --verify` | `git commit` of `workspace/` to a private repo, every pass | High. Off-box and diffable |
| Model fallback chain | Nothing. A provider outage fails the pass; cron retries | Accepted loss |
| Control UI | Kanboard's own UI for the board; `tail` and `jq` for everything else | Partial loss |
| Multi-agent routing, `templates/new-agent` | A prompt file and a cron line | Simplification, not a loss |

**On secrets, say the true thing.** OpenClaw's store was never an HSM: its values sat in local SQLite, protected by filesystem permissions. A 0600 file protected by filesystem permissions is the same security property with less machinery. What we actually lose is redaction — OpenClaw kept values out of model context by construction, and a shell-sourced env var is one `env` call away from a transcript. The mitigation is that `ichabod` is root-equivalent anyway and always was; the membrane, which is the process we do not trust, gets only the ChatGPT login.

## The board

**Decided: Kanboard at `ichabod-board.zfleeman.com`, home-hosted on Zach's Synology, reached by a `board` shell wrapper over its JSON-RPC API. Not over MCP.**

That second sentence is the whole design decision, and it is worth being blunt about why. MCP tool schemas are the tax this migration exists to remove — the 20-tool director preamble measured at 38,831 tokens carries 67,183 characters of tool schemas, most of it OpenClaw's 14 bridged MCP tools, re-sent on every single turn. Bolting a Kanboard MCP server onto Pi recreates that in miniature, permanently, for a board we could reach with `curl`. Pi does not ship MCP support at all; it arrives through a third-party adapter, and the most-recommended one advertises itself as "token-efficient," which tells you what the naive version costs.

Kanboard's API does not need any of that. It is JSON-RPC over HTTP with basic auth — username `ichabod`, password that user's personal API token — so the whole integration is one script:

```bash
#!/usr/bin/env bash
# board <method> [json-params]   e.g. board getAllTasks '{"project_id":1,"status_id":1}'
set -euo pipefail
curl -sS -u "ichabod:$KANBOARD_TOKEN" "$KANBOARD_URL/jsonrpc.php" \
  -d "$(jq -cn --arg m "$1" --argjson p "${2:-{\}}" \
        '{jsonrpc:"2.0",id:1,method:$m,params:$p}')" | jq '.result'
```

**That costs zero preamble tokens.** `bash` is already one of Pi's four tools; the wrapper needs no schema, only three lines of usage in `route.md`. Compare that to a schema per board method on every request. It is also strictly more debuggable — you can run `board getAllTasks '{"project_id":1}'` yourself in a shell and see exactly what the agent sees, which is the verification style this project has learned to trust.

**Ichabod authenticates as his own Kanboard user, not with the global `jsonrpc` token.** The instance exists only for him, so the `ichabod` user is an admin. The user token still beats the global one: comments and moves are attributed to Ichabod, and his token can be revoked on its own. Two things go with admin rights. Zach keeps a separate admin account, so Ichabod can never lock him out. And the plugin installer is off (`PLUGIN_INSTALLER=false`), because Kanboard plugins are PHP, and an admin who can install one can run code on the Synology, which is outside Ichabod's boundary.

### Where Kanboard runs

The box has no inbound SSH and reaches the world outbound only, and the loop needs the board every fifteen minutes. That constrains reachability, not location: the box just needs a public HTTPS endpoint to call, wherever the server actually sits.

**Decided: home-hosted, on Zach's Synology, behind the reverse proxy already running there, at `ichabod-board.zfleeman.com`.** The reverse proxy and its cert already exist for other services, so this is one more hostname on infrastructure already up, not new machinery. Ichabod reaches it exactly like any other outbound HTTPS call from the `board` wrapper — the box makes no distinction between a hostname resolving to its own Traefik and one resolving to a home IP. No tunnel and no VPN client to keep alive on ichabod.

This drops both consequences the on-box plan would have carried:

- **Ichabod has no path to destroy the board.** Kanboard's Docker lives on the Synology, not on the box, so `AGENTS.md`'s Docker authority (including `system prune` and volume removal) never reaches it. No named exception needed.
- **The board no longer dies with the box.** A `tofu` rebuild is a new EBS volume for ichabod, but Kanboard's data lives on separate hardware Zach controls directly. The nightly `board getAllTasks` dump into the workspace repo is still worth keeping regardless — a diffable, off-box mirror is useful for history and for restoring into a fresh Kanboard no matter which machine failed.

This reverses an earlier call: home hosting was floated and set aside because it seemed to mean joining the box to a tailnet and putting a tunnel in the operating loop. That concern doesn't apply here — the reverse proxy and public hostname already exist on the Synology, so there's no new inbound path to build, just a new subdomain on something already running. The remaining risk is home network and power uptime, which Zach is accepting directly rather than routing around.

### On GitHub Projects, since you asked

Yes, and they are properly scriptable. `gh project` went GA and covers `item-add`, `item-list`, `field-list`, and `item-edit`, and you can set a status by name rather than by node id:

```bash
gh project item-edit 1 --owner ich4bod \
  --url https://github.com/ich4bod/work/issues/23 \
  --field "Status" --value "In Progress"
```

So it is a real fallback if Kanboard turns out to be a nuisance. The caveats: Projects v2 is user- or org-scoped rather than repo-scoped, the token needs the `project` scope and fine-grained token support there has historically been patchy, and the by-name convenience sits on a GraphQL API that gets fiddly the moment you need anything custom. Plain Issues plus labels gets you most of a kanban with a fraction of the moving parts, and `gh issue list --json` is smaller than anything Projects returns.

Fallback order, if Kanboard turns out to be a nuisance: GitHub Projects or plain Issues, then SQLite, then markdown files. The `board` wrapper is the seam that makes this cheap to change — every prompt calls `board <verb>`, so swapping the substrate is a rewrite of one script, not of five prompts.

## The membrane

Its own document, because it is the only safety-critical piece here and it outlives this plan: **[MEMBRANE.md](MEMBRANE.md)**. Read that before writing a line of `intake`.

The short version. An email's *sender* is verified by the IMAP gate; its *content* never is, because Zach forwards things he did not write. A language model cannot tell instructions from data — they arrive as one block of text — so no amount of escaping makes hostile content safe. The only reliable answer is to split reading from acting: the process that sees the email can do nothing, and the process that can do anything never sees the email.

Under Pi that becomes three steps. `intake` fetches one message. It pipes the body to `pi -p --tools ""` — an empty tool list, so the reader has no shell, no files, no network — under `env -i` so it inherits no credentials. Pi prints JSON with four fields; `intake` validates it and writes the card itself.

The gain over today is that the model stops making a tool call and starts filling in a form. `triage-guard` exists because a card could assign itself, and a hook had to strip the offending fields out of the model's own arguments. In the new shape the schema has no field for an owner, a command, or a schedule, so those cannot be expressed at all. The guard becomes unnecessary rather than enforced.

Zach chose to run this as `ichabod` rather than as a credential-free user of its own. MEMBRANE.md records exactly what that costs and the three flags that buy most of it back.

## Teardown

Full destruction first, then a clean build. The repo is already trimmed (2026-09-13); `git show d005f4a:<path>` recovers anything from the OpenClaw era, and nothing on the box is being preserved.

- [ ] **Revoke what the old box held.** The mailbox app password, the `gh` token, the OpenAI key, and the old box's SSH key on the `ich4bod` account. Their only copies are about to be destroyed, so reissue rather than recover.
- [ ] **Replace the instance.** In `tofu/main.tf` set `disable_api_termination = false` and apply, refresh `ami_id` in `terraform.tfvars`, then `tofu -chdir=tofu apply -replace=aws_instance.ichabod`. Set termination protection back to `true` and apply again. The Elastic IP, DNS, alarms and budget are separate resources and survive, and the association moves to the new instance on its own.
- [ ] **Build the host** from [ICHABOD-GUIDE.md](ICHABOD-GUIDE.md#5-host), then Traefik. Sites under `*.ichabod-crane.net` come back by redeploying from their `ich4bod` repositories.

## Build

On the new instance, in rough order:

- [ ] **Prove Pi.** Install `pi` as `ichabod`. Settle the run-mode flags and read one real `--mode json` stream for the actual `usage` field names. Run `scout.md` by hand and measure the preamble off the first usage event.
- [ ] **Settle the allowance.** Log in to Ichabod's ChatGPT Plus account (`ichabod@ichabod-crane.net`) on the box with Pi's device code login, and pick the models. Prove `usage` works headless. Run the crontab for a day, then a day with dispatched workers, and check whether either hits the 5-hour or weekly limit — a pass is light, **workers on the strongest model are not**, and they are where the usage lives.
- [ ] **The board.** Kanboard on the Synology at `ichabod-board.zfleeman.com`, with an `ichabod` user and its personal API token as `KANBOARD_TOKEN`, and columns triage, backlog, ready, running, review, blocked, done. `board` written, and `board createTask` works from inside Pi's `bash`. A nightly `board getAllTasks` dump committed into the workspace repo.
- [ ] **`runtime/` in this repo:** `bin/`, `prompts/`, a crontab, and a deploy script. The old deploy's trick still works — SSM has no file copy, so ship a base64 tarball inside a run-command, built with `COPYFILE_DISABLE=1 tar --no-xattrs` so macOS metadata files stay out. `git show d005f4a:scripts/deploy-workspace` has it.
- [ ] **`notify`,** proven by a real email arriving with the right envelope sender.
- [ ] **Prompts.** Port `scout.md` and `digest.md`. Rewrite `director.md` into `route.md` against `board` — the projection one-liner and the twin-card retirement both disappear, since Kanboard returns small results and tasks can be edited in place. Write `work.md`: take the top `ready` task, do it, comment what happened, move the column. Reasoning goes on the card as a comment, so most of `memory/YYYY-MM-DD/` stops existing.
- [ ] **The membrane.** `intake` and `membrane.md` built to [MEMBRANE.md](MEMBRANE.md), and all four of [its tests](MEMBRANE.md#how-to-test-it) passing — injection, credentials, malformed output, and a normal request. Not three.
- [ ] **`health`,** and a check that it shouts when a pass has not succeeded.
- [ ] **`workspace/AGENTS.md`** finished against the real stack, including the journal rules the board made obsolete.
- [ ] **End to end.** Install the crontab, email Ichabod a small request, and watch it go from intake to a reply.

`zf/pi-migration` merges to `main` once that last box is ticked.

## Later

- Re-check the instance type. `t3a.large` was sized for a Node Gateway, a sandbox image, and Docker. Two of those are gone.
- Fold `route` and `work` into one loop if the separation has not earned itself.

## What we lose, stated plainly

- OpenClaw's Control UI. Kanboard replaces the part of it that showed the board, and nothing replaces the part that showed sessions, tool calls and agent state — that becomes `jq` over `log/`.
- Model fallback. A provider outage becomes a failed pass rather than a slower one.
- Typed plugin surfaces. Everything becomes shell and Python, which is easier to read and easier to get subtly wrong.
- The multi-agent story. `templates/new-agent` and "agents Ichabod creates himself" become "another prompt file and another cron line" — smaller, and less interesting.
- OpenClaw's own operational knowledge, several weeks of it hard-won. It was cut rather than archived in place; `git log` has it.

## What gets simpler

- One preamble we control completely, instead of a third of it arriving from a server overnight.
- Synchronous `bash`, which is the contract every prompt on this box is already written against.
- Every failure reproducible from a shell. No `config validate` that passes on broken states, no `sandbox explain` that reports a boundary that isn't there.
- The trust boundary enforced by the kernel rather than by a config file, and testable by attacking it.
- Everything in git, including memory, including the journal.
- Nothing to keep alive. There is no daemon whose death is a silent outage.

## Open questions

- Which OpenAI model does each job?
- Does a Plus allowance cover the crontab and the dispatched workers, or does it need Pro? The passes are light and the workers are not, and only the workers are unbounded.
- Is one Kanboard project with columns enough, or does the router want swimlanes per kind of work?
- Does `route`/`work` need to stay split? Answerable only after it has run for a while.
