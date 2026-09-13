# Migrating off OpenClaw

The plan for replacing OpenClaw with Pi and cron. Written 2026-09-11, after [HARNESS-ALTERNATIVES.md](HARNESS-ALTERNATIVES.md) measured where the tokens go and [OPENCLAW-AND-PI.md](OPENCLAW-AND-PI.md) worked out how the two fit together. Those two are the reasoning; this is the build order.

The goal is a box you can hold in your head: a handful of shell scripts, a crontab, prompt files, and `pi`. No Gateway, no TypeScript plugins, no `openclaw.json`, no Control UI. The [README's comparison table](../README.md#how-this-differs-from-the-clone-kit) currently describes a platform on one side and Rohrer's clone kit on the other, and this moves us most of the way toward the kit's column — deliberately, and with one exception.

## Decisions already taken

Settled, so that the phases below read as work rather than as options. The reasoning for each is in the section it belongs to.

| Decision | Where |
|---|---|
| Pi plus cron replaces OpenClaw entirely | this document |
| The board is Kanboard, home-hosted on Zach's Synology, at `ichabod-board.zfleeman.com` | [The board](#the-board) |
| The agent reaches the board through a `board` shell wrapper, **not** MCP | [The board](#the-board) |
| The mail membrane keeps its boundary, rebuilt around a tool-less reader | [MEMBRANE.md](MEMBRANE.md) |
| The membrane runs as `ichabod`, not as a user of its own | [MEMBRANE.md](MEMBRANE.md) |
| Nothing on the box is deleted until Phase 5 | [Branch discipline](#branch-discipline) |

Still open, and gating: whether Pi can use the Claude subscription or this is API-key-only, and what dispatched workers cost on an API key. Phase 0 answers both.

## The one thing that must not regress

The exception is the trust boundary. The README says it plainly: **the kit optimizes for never stopping, and this project optimizes for never trusting the input.** Simplifying the machinery is the whole point of this migration; dropping the membrane is not part of it, and a version of this plan that quietly loses it is a failure even if every pass runs.

The good news is that it should get *stronger*. Every sandbox failure this project has recorded was the same shape: config declared a boundary that nothing enforced, and the tool that reports on it lied. `sandbox explain` printed `runtime: sandboxed` for a reader that had a shell, Docker, and the network. Under Pi the membrane stops being a config assertion and becomes a Unix one — a separate user with no credentials, running a process started with no tools. That is a claim you verify by trying to break it, which is the only kind of verification this project has found reliable.

## The gate before anything else

**Do not start Phase 1 until Phase 0 answers two questions.** Everything below assumes Pi can do the work and that we can afford it, and neither is established.

Nothing in this plan is expensive to abandon at Phase 0. Everything after it is.

## Target architecture

One box, three Unix users, five scripts, one crontab.

```
/srv/ichabod/
  bin/
    pass          run one prompt file under pi, with a lock and a timeout
    board         one curl per Kanboard JSON-RPC method, the agent's only board access
    intake        fetch mail -> membrane -> card
    notify        send one email
    health        touch on success; shout when stale
  prompts/
    route.md  work.md  scout.md  digest.md  membrane.md
  workspace/      AGENTS.md, IDENTITY.md, SOUL.md, USER.md, MEMORY.md, memory/, skills/
  log/            YYYY-MM-DD/HHMM-<pass>.jsonl, one per run
  env             0600, the API keys, sourced by the wrappers
```

| User | Runs | Has |
|---|---|---|
| `ichabod` | every pass, every worker, and the membrane wrapper | Docker, `gh`, the API keys, the mailbox, sudo where it already has it |
| `openclaw` | nothing, once this is done | deleted at the end |

The membrane runs as `ichabod` rather than as a user of its own — see [The membrane, rebuilt](#the-membrane-rebuilt) for what that costs and how the isolation is kept anyway.

The crontab, as a starting shape:

```cron
*/5  * * * *  /srv/ichabod/bin/intake
*/15 * * * *  /srv/ichabod/bin/pass route
*/15 * * * *  /srv/ichabod/bin/pass work
0 4,11,18 * * *  /srv/ichabod/bin/pass scout
0 7  * * *    /srv/ichabod/bin/pass digest
```

`pass` is the whole harness. Roughly:

```bash
#!/usr/bin/env bash
set -euo pipefail
name="$1"
set -a; . /srv/ichabod/env; set +a
day="$(date +%F)"; out="/srv/ichabod/log/$day/$(date +%H%M)-$name.jsonl"
mkdir -p "/srv/ichabod/log/$day"

rc=0
flock -n "/run/ichabod/$name.lock" \
  timeout 1800 \
  pi --mode json --tools read,write,edit,bash --no-session \
     -C /srv/ichabod/workspace \
     @"/srv/ichabod/prompts/$name.md" > "$out" || rc=$?

# The number this whole migration is about, one line per pass. Field names are
# a guess until Phase 0 reads a real event; do not trust this jq as written.
jq -s '[.[] | .usage // empty] | {pass: "'"$name"'",
       in: (map(.input_tokens) | add), out: (map(.output_tokens) | add)}' \
  "$out" >> /srv/ichabod/log/cost.jsonl
exit $rc
```

`flock -n` is the concurrency rule that `--max-starts 1` enforces today: if the previous run is still going, this one exits rather than stacking. `timeout` is the stall recovery that "a `running` card that has not moved in over an hour is stuck" currently handles by hand. `rc` is captured rather than allowed to abort under `set -e`, because a failed pass still has a log worth summarising.

### Which run mode, and why

Pi has four: interactive, print (`-p`), JSON (`--mode json`), and RPC (`--mode rpc`). Two of them are used here.

**Passes use `--mode json`.** `-p` prints the final assistant message and nothing else — no token counts, no record of which tools were called. The whole point of this migration is a token number, so a mode that does not emit one leaves us blind in the exact place we are trying to see. JSON mode also means the log file and the event stream are the same artifact, so there is no separate logging to write, and a pass killed by `timeout` still leaves everything up to the kill rather than nothing.

**The membrane uses `-p`.** Its contract is four fields of JSON validated by the wrapper. Under `--mode json` the wrapper would have to pull the assistant text out of an event envelope and then parse that — two parsers on the one path where hostile input arrives, which is the wrong place to add surface. Its token usage does not need measuring either. One trap to handle in `intake`: models commonly wrap JSON output in Markdown fences, so strip fences before parsing rather than assuming a bare object.

**Nothing uses RPC.** RPC holds a live session and exposes `prompt`, `steer`, `follow_up`, `abort` and `get_state` over line-delimited JSON on stdin. That is for an orchestrator that wants to intervene mid-turn. Our passes are fire-and-forget — cron starts them, they finish or time out, and there is nothing to steer. Adopting it means writing a client that owns process lifecycle and framing, which is a daemon, which is the category of machinery we are removing OpenClaw to be rid of. It becomes worth revisiting only if a pass needs to be interruptible, or if `route` and `work` collapse into one long-lived loop — a Phase 6 question.

**Verify the flag spelling in Phase 0.** An earlier draft of this document wrote `pi -p --mode json`. That is probably invalid, since `-p` is very likely shorthand for `--mode print`, in which case the two contradict and one wins silently. Confirm which before the wrapper is built on it.

**Keep `route` and `work` separate at first, even though collapsing them is tempting.** `route.md` is `director.md` with the workboard commands swapped out, and that prompt is battle-tested — eight numbered steps refined against real failures. `work.md` is new. Merging them into one "read the board, do the next thing" loop is the genuinely Sammy-shaped end state and is probably right eventually, but it changes two things at once. Do it as a later simplification, once the substrate is proven, and do it because the separation turned out not to earn its keep rather than on principle.

## What replaces what

| OpenClaw provides | Replacement | Confidence |
|---|---|---|
| Scheduler (`automations`) | cron + `flock` + `timeout` | High. This is cron's actual job |
| Agent loop, context assembly | `pi -p` | High, pending Phase 0 |
| Workboard | Kanboard, reached by a `board` shell wrapper over JSON-RPC | High. The API is plain HTTP |
| `triage-guard` hook | The membrane's wrapper — it parses Pi's output and writes the card itself | High. Stronger than a hook |
| Sandbox for `mail_reader` | Pi started with no tools, under `env -i` | High, and testable |
| IMAP intake plugin | ~40 lines of Python `imaplib` in `intake` | High. It already does DMARC checks we can keep |
| `smtp-send` plugin | ~20 lines of Python `smtplib` in `notify` | High |
| `mailbox` plugin (search/archive) | The same script, more subcommands | High |
| SecretRefs + secret store | `/srv/ichabod/env`, mode 0600 | High, and honest — see below |
| Session ledger, token accounting | Pi's `--mode json` events, one file per run in `log/` | High. Better for forensics than today |
| `backup create --verify` | `git commit` of `workspace/` to a private repo, every pass | High. Off-box and diffable |
| Model fallback chain | Nothing. A provider outage fails the pass; cron retries | Accepted loss |
| Control UI | Kanboard's own UI for the board; `tail` and `jq` for everything else | Partial loss |
| Multi-agent routing, `templates/new-agent` | A prompt file and a cron line | Simplification, not a loss |

**On secrets, say the true thing.** The guide already concedes OpenClaw's store "is not an HSM: values are stored in its local SQLite state and protected by filesystem permissions." A 0600 file protected by filesystem permissions is the same security property with less machinery. What we actually lose is redaction — OpenClaw kept values out of model context by construction, and a shell-sourced env var is one `env` call away from a transcript. The mitigation is that `ichabod` is root-equivalent anyway and always was; the membrane, which is the user we do not trust, gets no keys at all.

## The board

**Decided: Kanboard at `ichabod-board.zfleeman.com`, home-hosted on Zach's Synology, reached by a `board` shell wrapper over its JSON-RPC API. Not over MCP.**

That second sentence is the whole design decision, and it is worth being blunt about why. MCP tool schemas are the tax this migration exists to remove — the 20-tool director preamble measured at 38,831 tokens carries 67,183 characters of tool schemas, most of it OpenClaw's 14 bridged MCP tools, re-sent on every single turn. Bolting a Kanboard MCP server onto Pi recreates that in miniature, permanently, for a board we could reach with `curl`. Pi does not ship MCP support at all; it arrives through a third-party adapter, and the most-recommended one advertises itself as "token-efficient," which tells you what the naive version costs.

Kanboard's API does not need any of that. It is JSON-RPC over HTTP with basic auth — username `jsonrpc`, password the API token — so the whole integration is one script:

```bash
#!/usr/bin/env bash
# board <method> [json-params]   e.g. board getAllTasks '{"project_id":1,"status_id":1}'
set -euo pipefail
curl -sS -u "jsonrpc:$KANBOARD_TOKEN" "$KANBOARD_URL/jsonrpc.php" \
  -d "$(jq -cn --arg m "$1" --argjson p "${2:-{\}}" \
        '{jsonrpc:"2.0",id:1,method:$m,params:$p}')" | jq '.result'
```

**That costs zero preamble tokens.** `bash` is already one of Pi's four tools; the wrapper needs no schema, only three lines of usage in `route.md`. Compare that to a schema per board method on every request. It is also strictly more debuggable — you can run `board getAllTasks '{"project_id":1}'` yourself in a shell and see exactly what the agent sees, which is the verification style this project has learned to trust.

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

## Phases

Each phase ends in a state the box can sit in indefinitely. Nothing after Phase 0 is a big-bang cutover.

### Phase 0 — Prove it, change nothing

- [ ] Install `pi` on the box as a new `ichabod` user. OpenClaw keeps running untouched.
- [ ] Settle the run-mode flags. Confirm whether `-p` and `--mode json` can be combined, and read one real event stream to get the actual `usage` field names before the `pass` wrapper's `jq` is written.
- [ ] Run `scout.md` under `pi --mode json` by hand. Measure the preamble off the first usage event.
- [ ] Stand up Kanboard on the Synology, behind the existing reverse proxy, at `ichabod-board.zfleeman.com`, and write `board`. Confirm the round-trip: `board createTask` from inside Pi's `bash`, as `ichabod`.
- [ ] Establish the model and the currency. Can Pi use the Claude subscription, or is this API-key-only? Price one real pass, then multiply by the crontab above and by a day of dispatched workers.
- [ ] **Gate:** a measured preamble well under 38,831, a real card created through `board`, and a daily cost Zach has looked at and accepted. If any one fails, stop and keep OpenClaw.

The cost question is the one to be careful with. Zach has accepted an API key for a pass, and a pass is cheap. **Dispatched workers on Opus are not**, and they are where the token volume actually lives. Price those separately before committing.

### Phase 1 — Skeleton, nothing scheduled

- [ ] `runtime/` in this repo: `bin/`, `prompts/`, a crontab template, a deploy script.
- [ ] Deploy it alongside OpenClaw. Both stacks on the box, only one of them scheduled.
- [ ] `notify` first, since the digest needs it, and it is the smallest end-to-end proof that the new stack can reach the outside world.
- [ ] **Acceptance:** an email from `notify`, sent by cron, arriving with the right envelope sender.

### Phase 2 — Move the read-only passes

Scout and digest. They read and report; if they break, nothing is lost and you find out in a day.

- [ ] Port `scout.md` and `digest.md` to the new prompts directory.
- [ ] Remove the OpenClaw jobs for both, add the cron lines.
- [ ] Run for three days next to an untouched director.
- [ ] **Acceptance:** three digests, three days of scout sweeps, no silent skips. Compare per-pass cost against Phase 0's estimate.

### Phase 3 — The board

The biggest single piece, and the point of no easy return.

- [ ] Kanboard is already up from Phase 0. Define the swimlanes and columns to match today's statuses: triage, backlog, ready, running, review, blocked, done.
- [ ] Add the nightly `board getAllTasks` dump, committed into the workspace repo.
- [ ] Migrate live cards. Everything not `done` becomes a Kanboard task; `done` cards export to one file and are dropped.
- [ ] Rewrite `director.md` into `route.md` against `board`. Steps 2, 4, 5 and 6 get shorter; step 1's projection one-liner and step 7's twin-retirement both disappear, since Kanboard returns small results and tasks can be edited in place.
- [ ] Move the journal onto the card. Kanboard tasks take comments, so most of `memory/YYYY-MM-DD/` stops existing and the passes stop reading it.
- [ ] Write `work.md` — take the top `ready` task, do it, comment what happened, move the column.
- [ ] **Acceptance:** a week of routing and one real card taken from `triage` to `done` entirely on the new stack, with the reasoning readable on the card rather than in the journal.

### Phase 4 — The membrane

- [ ] Provision `MEMBRANE_KEY` as a second API key with its own spend cap.
- [ ] Build `intake` and `membrane.md` to the spec in [MEMBRANE.md](MEMBRANE.md), including the flag comment it asks for.
- [ ] **Acceptance:** all four tests in [MEMBRANE.md](MEMBRANE.md#how-to-test-it) — injection, credentials, malformed output, and a normal request. Turn off OpenClaw's IMAP account only after all four pass, not three.

### Phase 5 — Delete OpenClaw

One commit, at the end, so the branch is additive until it isn't.

- [ ] Stop and disable the Gateway. Uninstall.
- [ ] Delete `plugins/`, `scripts/configure-*`, `scripts/install-plugin`, `scripts/build-sandbox-image`, the `sync`/`imap`/`plugins`/`ui`/`openclaw` Makefile targets.
- [ ] Rewrite `README.md` and `docs/ICHABOD-GUIDE.md`. Most of the guide's hard-won OpenClaw lessons stop applying and should be cut, not archived in place — `git log` is the archive.
- [ ] Rewrite `workspace/AGENTS.md`: no Workboard cards, no Gateway restarts, no `openclaw` authority language.
- [ ] Delete the `openclaw` user, and the `triage-guard` plugin with it — it has no job left.

### Phase 6 — Reap

- [ ] Re-check the instance type. `t3a.large` was sized for a Node Gateway, a sandbox image, and Docker. Two of those are gone.
- [ ] Fold `route` and `work` into one loop if the separation has not earned itself.

## Branch discipline

- `zf/pi-migration` off `main`, long-lived, merged once at the end.
- **Additive until Phase 5.** Nothing is deleted while the old stack is still the one serving. That keeps the diff reviewable and every phase revertible with one deploy.
- Land the two memos on `main` first, in their own small PR, so this branch is only the build.
- Both stacks coexist on the box the whole time, under different Unix users. Cutover is per pass, by moving one cron line, never by flipping the machine.
- Each phase is its own commit with its acceptance evidence in the message.

## What we lose, stated plainly

- OpenClaw's Control UI. Kanboard replaces the part of it that showed the board, and nothing replaces the part that showed sessions, tool calls and agent state — that becomes `jq` over `log/`.
- Model fallback. A provider outage becomes a failed pass rather than a slower one.
- Typed plugin surfaces. Everything becomes shell and Python, which is easier to read and easier to get subtly wrong.
- The multi-agent story. `templates/new-agent` and "agents Ichabod creates himself" become "another prompt file and another cron line" — smaller, and less interesting.
- OpenClaw's own operational knowledge, most of `docs/ICHABOD-GUIDE.md`, several weeks of it hard-won.

## What gets simpler

- One preamble we control completely, instead of a third of it arriving from a server overnight.
- Synchronous `bash`, which is the contract every prompt on this box is already written against.
- Every failure reproducible from a shell. No `config validate` that passes on broken states, no `sandbox explain` that reports a boundary that isn't there.
- The trust boundary enforced by the kernel rather than by a config file, and testable by attacking it.
- Everything in git, including memory, including the journal.
- Nothing to keep alive. There is no daemon whose death is a silent outage.

## Open questions

- Can Pi use the Claude subscription, or is this API-key-only? Phase 0, and it sets the budget.
- What do dispatched workers cost on an API key? The passes are cheap and the workers are not, and only the workers are unbounded.
- Does Kanboard-on-the-box hold up, or does the board want to live somewhere a `tofu` rebuild cannot take with it?
- Is one Kanboard project with columns enough, or does the router want swimlanes per kind of work?
- Does `route`/`work` need to stay split? Answerable only after Phase 3 has run for a while.
