# Runtime

How Ichabod thinks and acts on the box: Pi, cron, the board, and the scripts between them. The machine underneath is [ICHABOD-GUIDE.md](ICHABOD-GUIDE.md), and the mail boundary is [MEMBRANE.md](MEMBRANE.md).

The goal is a box you can hold in your head: a handful of shell scripts, a crontab, prompt files, and `pi`. No daemon, no plugins, no dashboard, nothing to keep alive. The work still in front of that goal is [Open actions](#open-actions) at the bottom.

## Why Pi and cron

**The preamble is the cost.** Every turn re-sends everything the model was handed before it started, so tokens spent on framework are paid out of the same allowance as the real work. A routing pass under the previous harness carried 38,831 tokens before its first action: about a third was a server-delivered system prompt nobody here controlled, and most of the rest was tool schemas from three tool surfaces stacked on one agent. Pi is four tools and a system prompt under 1,000 tokens, which leaves a preamble made almost entirely of our own words.

**Nothing may quietly weaken the trust boundary.** Simple machinery is the point; dropping the membrane to get it is not. Under Pi the membrane is a process started with no tools and an empty environment rather than a configuration claim, which is a thing you can verify by trying to break it.

## Layout

One box, one Unix user, one crontab. The repo's [`home/`](../home) mirrors `/home/ichabod`, so whatever exists there is the real file.

```
/home/ichabod/
  bin/
    run-pass      run one prompt file under pi, with a lock and a timeout
    board         one curl per Kanboard JSON-RPC method, the agent's only board access
    intake        fetch mail -> membrane -> card
    notify        send one email
    health        touch on success; shout when stale
    usage         the ChatGPT Plus 5-hour and weekly usage, as one JSON line
    backup-workspace, set-secret
  prompts/
    route.md  work.md  scout.md  digest.md  membrane.md
  workspace/      AGENTS.md, IDENTITY.md, SOUL.md, USER.md, MEMORY.md, memory/, skills/, own-skills/
  log/            YYYY-MM-DD/HHMM-<pass>.jsonl, one per run, plus cost.jsonl and usage.jsonl
  .config/ichabod/env  0600, tokens and passwords, sourced by the wrappers; env.example lists them
```

`ichabod` runs every pass, every worker, and the membrane wrapper, and holds Docker, `gh`, the ChatGPT login and the mailbox. The membrane runs as `ichabod` rather than as a user of its own; [MEMBRANE.md](MEMBRANE.md#what-we-deliberately-gave-up) explains what that costs and how the isolation is kept anyway.

The schedule is [`home/crontab`](../home/crontab), installed as `/etc/cron.d/ichabod-schedule` by `make cron`. It is kept out of `make deploy` so a deploy never re-enables passes a kill switch stopped, and it lives in `/etc/cron.d` so Ichabod's own crontab stays his.

`make deploy` ships `home/`, and [`scripts/install-home`](../scripts/install-home) holds its rules: shipped files owned by root and read-only to `ichabod`, drift since the last deploy refused unless `FORCE=1`, `USER.md` and `MEMORY.md` seeded once, `memory/` and `own-skills/` never touched.

## Passes

| Pass | Job |
|---|---|
| `route` | Read the board and decide: triage new cards, pick the next `ready` card, recover stale ones, close verified `review` cards |
| `work` | Take the top `ready` card, do it, comment what happened on the card, move the column |
| `scout` | Turn open GitHub issues into cards, then propose at most one piece of self-directed work |
| `digest` | One email a day: what finished, what is blocked, usage |

**Reasoning goes on the card as a comment.** The board is the queue and the record, so the journal in `memory/` only holds what does not belong to a card.

**`route` and `work` are separate on purpose, for now.** One "read the board, do the next thing" loop is probably the right end state, but it is a simplification to make once the two passes have run long enough to show whether the split earns its keep.

## run-pass

[`run-pass`](../home/bin/run-pass) is the whole harness.

- **`flock -n`** is the concurrency rule: if the previous run of that pass is still going, this one exits rather than stacking.
- **`timeout`** is stall recovery. A pass that hangs is killed, and its log up to the kill survives.
- **`rc` is captured** rather than allowed to abort under `set -e`, because a failed pass still has a log worth summarising and a workspace worth backing up.
- **It `cd`s into `workspace/`**, because Pi has no working-directory flag and finds `AGENTS.md` in the directory it starts in.

Skills load with `--no-skills` and two `--skill` folders: `workspace/skills/`, which ships from this repo, and `workspace/own-skills/`, which Ichabod writes himself. Nothing global loads. Pi only puts each skill's name and description in the system prompt, and the agent reads the full `SKILL.md` when a task matches; once read, a skill stays in context for the rest of the run. Project-local skill folders (`.pi/skills`, `.agents/skills`) are ignored in `--mode json` unless the project is trusted, which is why the paths are explicit.

After every pass, [`backup-workspace`](../home/bin/backup-workspace) commits `workspace/` and pushes it to a private `ich4bod` repository. It refuses to commit if a staged change contains any token or password from the env file or Pi's login, and a refusal fails the run so `health` sees it.

### Run modes

Pi has four: interactive, print (`-p`), JSON (`--mode json`), and RPC (`--mode rpc`).

**Passes use `--mode json`.** `-p` prints the final assistant message and nothing else: no token counts, no record of which tools were called. JSON mode makes the log file and the event stream the same artifact, so there is no separate logging to write.

**The membrane uses `-p`.** Its contract is four fields of JSON that the wrapper validates. Under `--mode json` the wrapper would have to pull text out of an event envelope and then parse it, which is two parsers on the one path where hostile input arrives.

**Nothing uses RPC.** RPC holds a live session for an orchestrator that wants to steer mid-turn. Passes are fire-and-forget, and a client that owns process lifecycle is a daemon, which is the category of machinery this design avoids. Revisit it only if a pass needs to be interruptible.

### Rules that have already been paid for

- **Never pass a prompt through `sudo -iu`.** The `-i` login shell re-parses the command line, so a Markdown prompt has its backticks executed on the box. It has happened. Cron runs as `ichabod` and needs no `sudo`; keep it that way.
- **Make failure loud.** A pass that dies at line 2 and a pass with nothing to do look identical from outside, and a stock heartbeat job once failed forty runs in a row unnoticed. `health` exists for this, and it must shout when its own check breaks rather than go quiet.
- **Re-check the tool list after every Pi upgrade.** An allowlist that silently changes meaning once swapped a synchronous shell for an async one, and a pass spent 14 turns in a sleep-and-poll loop.

## Models and usage

Ichabod runs on OpenAI models through a ChatGPT Plus subscription on his own account, logged in with Pi. The bill is flat, so the constraint is the subscription's 5-hour and weekly usage limits.

**Model by job.** A pass that routes and writes runs on a mid-tier model; a worker that builds gets the strongest one. The smallest tier is not used for routing, because triage is a judgment call on attacker-influenced text and it fails destructively.

The limits show on chatgpt.com, which nothing on the box can read. Two numbers stand in for it:

- **Tokens per run**, from Pi's own events into `log/cost.jsonl`. This is how hard each run worked.
- **Percent of the allowance used**, from `usage` into `log/usage.jsonl`. This is how much room is left.

[`usage`](../home/bin/usage) asks the endpoint that the Pi extensions [`pi-codex-rate-limits`](https://github.com/scnewma/pi-codex-rate-limits) and [`pi-codex-limit`](https://pi.dev/packages/pi-codex-limit) call, with the same login Pi uses. The endpoint is undocumented and can change without notice, so `--fail` makes a change an error `health` can see rather than a quiet gap in the log. The saved token lasts about ten days and Pi refreshes it when it runs, so `usage` only fails on expiry if Pi has not run in that long.

The digest reports from both files, and `route` can run `usage` before dispatching self-directed work and hold off above a weekly threshold Zach picks.

## The board

**Kanboard at `ichabod-board.zfleeman.com`, home-hosted on Zach's Synology, reached by the [`board`](../home/bin/board) shell wrapper over its JSON-RPC API. Not over MCP.**

MCP tool schemas are exactly the preamble tax Pi was chosen to remove: a schema per board method, re-sent on every turn, for a board reachable with `curl`. The wrapper costs zero preamble tokens, since `bash` is already one of Pi's four tools and the wrapper needs only a few lines of usage in the prompts. It is also more debuggable: you can run `board getAllTasks '{"project_id":1}'` in a shell and see exactly what the agent sees.

**Ichabod authenticates as his own Kanboard user**, with that user's personal API token as `KANBOARD_TOKEN`, not the global `jsonrpc` token. Comments and moves are attributed to him, and his token can be revoked on its own. The instance exists only for him, so the `ichabod` user is an admin, and two things go with that:

- Zach keeps a separate admin account with Kanboard's two-factor authentication, because the board sits on a public hostname and Ichabod must never be able to lock him out.
- The plugin installer is off (`PLUGIN_INSTALLER=false`). Kanboard plugins are PHP, and an admin who can install one can run code on the Synology, which is outside Ichabod's boundary.

**Why the Synology and not the box.** The box reaches the world outbound only, so it needs a public HTTPS endpoint wherever the board sits, and the Synology's reverse proxy already provides one. Hosting it there means Ichabod's Docker authority, including `system prune` and volume removal, never reaches the board, and the board does not die with the box on a rebuild. The accepted risk is home network and power uptime.

**The wrapper is the seam.** Every prompt calls `board <verb>`, so swapping the substrate is a rewrite of one script. If Kanboard becomes a nuisance, the fallback order is GitHub Issues with labels (or Projects, via `gh project item-edit`), then SQLite, then markdown files.

## Mail

**In:** `intake` fetches one message, gates it, hands the body to a Pi with no tools, validates the four fields it prints, and writes the card itself. That path is the only safety-critical one on the box, and [MEMBRANE.md](MEMBRANE.md) is its specification.

**Out:** `notify` is a short Python `smtplib` script with these rules, enforced in code:

- Zach is the only recipient.
- Envelope sender and `From` are both `ichabod@ichabod-crane.net`.
- Retry `4xx`, stop on `5xx`.
- A per-hour send cap, as a backstop against a retry loop.
- The SMTP password is redacted out of any error text.

Mailbox housekeeping, such as search and archive, is more subcommands on the same scripts.

## Trade-offs this design accepts

- **No model fallback.** A provider outage fails the pass, and the next scheduled run tries again.
- **No dashboard for sessions.** Kanboard shows the board; tool calls and agent state are `jq` over `log/`.
- **Shell and Python instead of typed plugins.** Easier to read, and easier to get subtly wrong.
- **A new agent is a prompt file and a cron line.** Smaller, and less interesting, than a multi-agent framework.
- **Secrets are not redacted from the model.** The env file is mode 0600, and a shell-sourced variable is one `env` call away from a transcript. `ichabod` is root-equivalent regardless, and the membrane, the process that is not trusted, inherits none of them.

## Open actions

What stands between the repository and the state described above. Tick them off by deleting them.

### Rebuild the box

- [ ] **Revoke what the previous box held.** The mailbox app password, the `gh` token, the OpenAI API key, and the old SSH key on the `ich4bod` account. Those values sat on a box that read untrusted mail, so issue fresh ones rather than reusing them. The OpenAI key is not replaced; the subscription covers models.
- [ ] **Replace the instance.** In `tofu/main.tf` set `disable_api_termination = false` and apply, refresh `ami_id` in `terraform.tfvars`, then `tofu -chdir=tofu apply -replace=aws_instance.ichabod`. Set termination protection back to `true` and apply again. The Elastic IP, DNS, alarms and budget are separate resources and survive.
- [ ] **Build the host** from [ICHABOD-GUIDE.md](ICHABOD-GUIDE.md#5-host), then Traefik. Sites under `*.ichabod-crane.net` come back by redeploying from their `ich4bod` repositories.
- [ ] **Put Traefik's compose file in the repo.** It lives only as a snippet in the guide, with an unpinned version placeholder, and anything not in the repo is lost on a rebuild.
- [ ] **Deploy.** `make deploy`, then again to confirm the second run changes nothing. Set each secret with `make secret`.

### Build the runtime

- [ ] **Prove Pi.** Install `pi` as `ichabod`, run `scout.md` by hand, and measure the real preamble off the first usage event. Confirm whether `-p` is shorthand for `--mode print`, so no script combines two modes that silently override each other.
- [ ] **Fix `run-pass`'s cost line.** Its `jq` guesses at the usage field names; read a real `--mode json` stream and correct it.
- [ ] **Make `timeout` kill Pi's children.** `timeout` signals its direct child, so a `bash` tool call can outlive it and keep spending. Check it, and add `--kill-after` or a process-group kill if needed.
- [ ] **Tell a skipped run from a failed one.** A run skipped by the lock exits 1 and leaves an empty log. `flock -n -E 75` with a clean early exit on 75 fixes that.
- [ ] **Settle the allowance.** Log in to Ichabod's ChatGPT Plus account with Pi's device code login, pick the models for each job, and prove `usage` works headless. Run the crontab for a day, then a day with workers, and check whether either hits the 5-hour or weekly limit. Workers on the strongest model are where the usage lives.
- [ ] **Stand up the board.** Kanboard on the Synology with the `ichabod` user and token, two-factor on Zach's account, the plugin installer off, and columns triage, backlog, ready, running, review, blocked, done. `board createTask` works from inside Pi's `bash`. A nightly `board getAllTasks` dump committed into the workspace repo as a diffable off-box mirror.
- [ ] **Write `notify`,** and prove it with a real email arriving with the right envelope sender.
- [ ] **Write `route.md` and delete `director.md`.** `director.md` is still written against the old workboard CLI. Carry over what it learned: read `backlog` before concluding there is nothing to do, dispatch one build-heavy card at a time, treat a `running` card that has not moved in an hour as stuck, close `review` only on work actually watched, and check `MEMORY.md` against its band. Drop the projection one-liner and the twin-card workaround, since Kanboard returns small results and tasks can be edited in place.
- [ ] **Write `work.md`.**
- [ ] **Check `scout.md` and `digest.md`** against the real board.
- [ ] **Build the membrane.** `intake` and `membrane.md` to [MEMBRANE.md](MEMBRANE.md), with its own `intake.lock` so a slow membrane call cannot overlap the next run and take the same message twice. All four of [its tests](MEMBRANE.md#how-to-test-it) pass before intake runs from cron.
- [ ] **Make the workspace backup real.** Create the private `ich4bod` repository and initialise `workspace/` against it.
- [ ] **Write `health`,** and prove it shouts when a pass has not succeeded.
- [ ] **Finish `AGENTS.md` against the real stack.** Its memory section still describes a per-pass journal the board makes mostly unnecessary.

### Prove it

- [ ] **End to end.** `make cron`, email Ichabod a small website idea, and receive a working HTTPS link, a short explanation, source history and test evidence without opening a session. Scheduled work survives a host reboot.
- [ ] **Rehearse recovery.** Restore one application backup into a disposable instance, and have Zach run every kill switch in [the guide](ICHABOD-GUIDE.md#kill-switches) in order rather than trusting that it is written down.
- [ ] **EBS snapshots.** Add a lifecycle policy to `tofu/`; the guide relies on one and none exists yet.
- [ ] **Session Manager logging.** Decide whether to log sessions to S3 or CloudWatch Logs so administrative access is auditable, and add it to `tofu/` if so.

### Things to figure out

- Which OpenAI model does each job, and does Plus cover the crontab and the workers or does it need Pro?
- Is one Kanboard project with columns enough, or does `route` want swimlanes per kind of work?
- Should `route` and `work` fold into one loop? Answerable only after they have run for a while.
- `scout` reads GitHub issues, and `ichabod-crane` is public, so a stranger's issue body reaches an agent with tools. Should issues from anyone but `zfleeman` go through the membrane the way email does?
- Is `t3a.large` still the right size? It was chosen when the box also ran a Node gateway and a sandbox image.
- What weekly usage threshold should hold off self-directed work?
