# Runtime

How Ichabod thinks and acts on the box: Pi, cron, the board, and the scripts between them. The machine underneath is [ICHABOD-GUIDE.md](ICHABOD-GUIDE.md), and the mail boundary is [MEMBRANE.md](MEMBRANE.md).

The goal is a box small enough that one person can understand all of it at once: a handful of shell scripts, a crontab, prompt files, and `pi`. No daemon, no plugins, no dashboard, nothing to keep alive. The work still in front of that goal is [Open actions](#open-actions) at the bottom.

## Why Pi and cron

**The preamble is the cost.** Every turn re-sends everything the model was handed before it started, so tokens spent on framework are paid out of the same allowance as the real work. A routing pass under the previous harness carried 38,831 tokens before its first action: about a third was a server-delivered system prompt nobody here controlled, and most of the rest was tool schemas from three tool surfaces stacked on one agent. Pi is four tools and a system prompt under 1,000 tokens, which leaves a preamble made almost entirely of our own words.

**Nothing may quietly weaken the trust boundary.** Simple machinery is the point; dropping the membrane to get it is not. Under Pi the membrane is a process started with no tools and an empty environment rather than a configuration claim, which is a thing you can verify by trying to break it.

## Layout

One box, one Unix user, one crontab. The repo's [`home/`](../home) mirrors `/home/ichabod`, so whatever exists there is the real file.

```
/home/ichabod/
  bin/
    run           run one prompt file under pi, with a lock and a timeout
    board         one curl per Kanboard JSON-RPC method, the agent's only board access
    receive-mail  fetch mail -> membrane -> card -> archive
    send-mail     send one email to Zach
    health        touch on success; shout when stale
    usage         the ChatGPT Plus 5-hour and weekly usage, as one JSON line
    set-secret    prompt for one secret and write it into the env file
  prompts/
    route.md  work.md  scout.md  digest.md  membrane.md
  workspace/      what Ichabod reads and remembers; see Memory below
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

**`route` and `work` are separate passes because they run on different models.** Pi takes one `--model` per run, so a single "read the board, do the next thing" loop would put routing and building on the same model. [Models and usage](#models-and-usage) says which job gets which. Fold them into one loop only if one model turns out to be right for both.

## Memory

Every run starts with an empty context, and nothing carries over from the last run except what is written down. Pi loads one file by itself; everything else the agent reads on purpose, with `read` or `grep`, when the work calls for it. That keeps the preamble small, and it means the file layout below is the memory design.

| File | Owner | How it reaches the model | What it holds |
|---|---|---|---|
| `workspace/AGENTS.md` | Zach | Loaded by Pi on every run | Mission, authority, operating rules, and the rules for the rest of this table |
| `SOUL.md`, `IDENTITY.md` | Zach | Read when needed | Voice, honesty rules, name and signature |
| `USER.md` | Ichabod | Read when needed | What he has learned about Zach, one dated directive per entry |
| `MEMORY.md` | Ichabod | Read when needed | Durable conclusions: decisions and why, lessons, facts about the estate. Kept between 4,000 and 5,500 characters |
| `memory/` | Ichabod | A day's contents page, then one entry at a time | The journal; see [below](#the-journal-memory) |
| `skills/`, `own-skills/` | Zach, Ichabod | Name and description every run; the full `SKILL.md` when a task matches | Procedures needed only sometimes |
| The board | Both | `board` calls | Everything about one card: acceptance criteria, reasoning as comments, its column |

A fact moves up that table as it proves it will last. It starts as a comment on a card or a journal entry, and when it will still matter in a month it becomes one line in `MEMORY.md`, with the detail left behind. `AGENTS.md` holds the exact rules, since it is the one file the agent is guaranteed to see.

Pi looks for `AGENTS.md` in `~/.pi/agent/`, in every parent of the directory it starts in, and in that directory. Only `workspace/AGENTS.md` exists, so only it loads. Creating `/home/ichabod/AGENTS.md` would silently add to every run's preamble.

`log/` is not memory. The passes read `cost.jsonl` and `usage.jsonl` from it, and the per-run transcripts are for Zach.

### The journal, `memory/`

```
memory/
  2026-09-14.md                    contents page: one line per entry, "HHMM-name — what it covers"
  2026-09-14/
    01-0215-traefik-cert-renewal.md
    02-0930-card-42.md
    03-1410-disk-cleanup.md
  2026-09-15.md
  2026-09-15/
    01-0340-docker-prune.md
```

**Why a day is a folder.** Under the previous harness the journal was one file per day. It reached 101,779 bytes, every pass opened it, and a file a pass opens is re-sent on every later turn of that run, so one day of journal spent the whole usage limit. Now a day is a contents page that fits on one screen plus one file per entry, and a pass reads the page and opens only the entries it needs.

**What goes in it.** What is worth keeping and does not belong to one card: a lesson about the box, a debugging trail that spans cards, a maintenance finding, the command that finally worked. Reasoning about a card goes on that card as a comment. A pass with nothing worth keeping writes nothing, which is the big change from the old director pass, whose cards could not take comments and so wrote an entry every run.

**Flat by day, on purpose.** The ISO date in each name already works as a year, month and day hierarchy (`memory/2026-09-*.md` is September), and `MEMORY.md` is the long-range summary, so there are no year or month folders or rollups to keep in sync. If a month view is ever wanted, a pass writes `memory/2026-09.md` beside the days it covers.

**Naming.** `NN-HHMM-<topic>.md`. `NN` is the entry's position in the day and keeps the folder in order, `HHMM` is when it was written, and `<topic>` is a short slug. An entry holding one card's detail that is too long for a comment is `card-<id>`, and the card links to it.

**Reading it.** The day's contents page first, then single entries. `grep -r` across `memory/` finds something older. Never open a whole day.

**How it ends.** Nothing deletes it. A day nobody opens costs nothing, so old days stay as an archive. When an entry holds something that will still matter in a month, one line of it goes into `MEMORY.md` and the detail stays behind. Deploys never touch `memory/`, it has no backup, and the digest flags a day that grows too large.

## run

[`run`](../home/bin/run) is the whole harness.

- **`flock -n`** is the concurrency rule: if the previous run of that pass is still going, this one exits rather than stacking.
- **`timeout`** is stall recovery. A pass that hangs is killed, and its log up to the kill survives.
- **`rc` is Pi's exit code**, where 0 means success. `run` saves it instead of letting `set -e` stop the script on a failure, so a failed pass still gets its line in `cost.jsonl`, and then exits with that code so cron and `health` see the failure.
- **It `cd`s into `workspace/`**, because Pi has no working-directory flag and finds `AGENTS.md` in the directory it starts in.

Skills load with `--no-skills` and two `--skill` folders: `workspace/skills/`, which ships from this repo, and `workspace/own-skills/`, which Ichabod writes himself. Nothing global loads. Pi only puts each skill's name and description in the system prompt, and the agent reads the full `SKILL.md` when a task matches; once read, a skill stays in context for the rest of the run. Project-local skill folders (`.pi/skills`, `.agents/skills`) are ignored in `--mode json` unless the project is trusted, which is why the paths are explicit.

**Passes run with `--no-session`.** A Pi session is a file in `~/.pi/agent/sessions/` holding one conversation, which Pi can reopen with `--resume` to keep talking, branch with `/tree`, or render as a web page with `--export`. The `--mode json` log already records every message and tool call of a run, so nothing is lost for reading back what happened. What is lost is reopening a finished pass to ask it why it did something. `--session-dir /home/ichabod/log/sessions` in place of `--no-session` would get that back, at the cost of a second copy of every run on disk.

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

The digest reports from both files. `route` runs `usage` before moving a self-directed (`wild-work`) card to `ready`, and leaves it in `backlog` while the weekly figure is at or above 70%, so Zach's requests keep the last part of the week.

## The board

**Kanboard at `ichabod-board.zfleeman.com`, home-hosted on Zach's Synology, reached by the [`board`](../home/bin/board) shell wrapper over its JSON-RPC API. Not over MCP.**

MCP tool schemas are exactly the preamble tax Pi was chosen to remove: a schema per board method, re-sent on every turn, for a board reachable with `curl`. The wrapper costs zero preamble tokens, since `bash` is already one of Pi's four tools and the wrapper needs only a few lines of usage in the prompts. It is also more debuggable: you can run `board getAllTasks '{"project_id":1}'` in a shell and see exactly what the agent sees.

**Ichabod authenticates as his own Kanboard user**, with that user's personal API token as `KANBOARD_TOKEN`, not the global `jsonrpc` token. Comments and moves are attributed to him, and his token can be revoked on its own. The instance exists only for him, so the `ichabod` user is an admin, and two things go with that:

- Zach logs in with his own Kanboard admin account, never Ichabod's. That account has two-factor authentication turned on (a one-time code from an authenticator app at login), because it is an admin login on a public hostname. If Ichabod ever breaks or deletes it, Zach resets it from the Kanboard container on the Synology, which Ichabod cannot reach.
- The plugin installer is off (`PLUGIN_INSTALLER=false`). Kanboard plugins are PHP, and an admin who can install one can run code on the Synology, which is outside Ichabod's boundary.

**Why the Synology and not the box.** The box reaches the world outbound only, so it needs a public HTTPS endpoint wherever the board sits, and the Synology's reverse proxy already provides one. Hosting it there means Ichabod's Docker authority, including `system prune` and volume removal, never reaches the board, and the board does not die with the box on a rebuild. The accepted risk is home network and power uptime.

**The wrapper is the seam.** Every prompt calls `board <verb>`, so swapping the substrate is a rewrite of one script. If Kanboard becomes a nuisance, the fallback order is GitHub Issues with labels (or Projects, via `gh project item-edit`), then SQLite, then markdown files.

## Mail

**In:** `receive-mail` works through unread mail. For each message it gates it, hands the body to a Pi with no tools, validates the four fields it prints, writes the card itself, and moves the message to `Archive`. That path is the only safety-critical one on the box, and [MEMBRANE.md](MEMBRANE.md) is its specification.

**Out:** `send-mail [--in-reply-to <message-id>] <subject>`, with the body on stdin, is a short Python `smtplib` script with these rules, enforced in code:

- Zach is the only recipient.
- Envelope sender and `From` are both `ichabod@ichabod-crane.net`.
- `--in-reply-to` sets `In-Reply-To` and `References`, so a reply threads under Zach's message.
- Retry `4xx`, stop on `5xx`.
- A per-hour send cap, as a backstop against a retry loop.
- The SMTP password is redacted out of any error text.

**There is no search or archive command, on purpose.** Replying needs the original `Message-ID`, and `receive-mail` writes it onto every card. It is the `Message-ID` header and never the IMAP UID, because a UID belongs to one folder and changes when the message moves: the same message was UID 21 in `INBOX` and UID 19 in `Archive` under the previous harness, with its `Message-ID` unchanged. Archiving keeps the inbox to unread mail, and `receive-mail` does that the moment the card exists. A search command would be a way for an agent with tools to read message bodies, which is exactly what the membrane exists to prevent. Rejected and quarantined mail waits in those folders for Zach to read in Fastmail.

## Trade-offs this design accepts

- **No model fallback.** A provider outage fails the pass, and the next scheduled run tries again.
- **No dashboard for sessions.** Kanboard shows the board; tool calls and agent state are `jq` over `log/`. If that gets old, swap `--no-session` for `--session-dir` (see [run](#run)) and `pi --export <session-file> run.html` turns any run into a web page to open on the laptop: a dashboard with nothing left running.
- **Shell and Python instead of typed plugins.** Easier to read, and easier to get subtly wrong.
- **A new agent is a prompt file and a cron line.** Smaller, and less interesting, than a multi-agent framework.
- **Secrets are not redacted from the model.** The env file is mode 0600, and a shell-sourced variable is one `env` call away from a transcript. `ichabod` is root-equivalent regardless, and the membrane, the process that is not trusted, inherits none of them.

## Open actions

What stands between the repository and the state described above. Tick them off by deleting them. Decisions that need Zach are GitHub issues, linked from the item they block. The list stays here until the pull request that moves Ichabod onto Pi merges, because until then it is the cutover plan; its last item moves what is left into issues.

### Rebuild the box

- [ ] **Revoke what the previous box held.** The mailbox app password, the `gh` token, the OpenAI API key, and the old SSH key on the `ich4bod` account. Those values sat on a box that read untrusted mail, so issue fresh ones rather than reusing them. The OpenAI key is not replaced; the subscription covers models.
- [ ] **Replace the instance.** In `tofu/main.tf` set `disable_api_termination = false` and apply, refresh `ami_id` in `terraform.tfvars`, then `tofu -chdir=tofu apply -replace=aws_instance.ichabod`. Set termination protection back to `true` and apply again. The Elastic IP, DNS, alarms and budget are separate resources and survive.
- [ ] **Build the host** from [ICHABOD-GUIDE.md](ICHABOD-GUIDE.md#5-host).
- [ ] **Deploy.** `make deploy`, then again to confirm the second run changes nothing. Set each secret with `make secret`. Then start Traefik from [its compose file](ICHABOD-GUIDE.md#traefik-once), and after it, bring back the sites under `*.ichabod-crane.net` by redeploying them from their `ich4bod` repositories.

### Build the runtime

- [ ] **Prove Pi.** Install `pi`, run `scout.md` by hand, and measure the real preamble off the first usage event. Confirm whether `-p` is shorthand for `--mode print`, so no script combines two modes that silently override each other. Where Pi is installed is [#67](https://github.com/zfleeman/ichabod-crane/issues/67).
- [ ] **Fix `run`'s cost line.** Its `jq` guesses at the usage field names; read a real `--mode json` stream and correct it.
- [ ] **Make `timeout` kill Pi's children.** `timeout` signals its direct child, so a `bash` tool call can outlive it and keep spending. Check it, and add `--kill-after` or a process-group kill if needed.
- [ ] **Tell a skipped run from a failed one.** A run skipped by the lock exits 1 and leaves an empty log. `flock -n -E 75` with a clean early exit on 75 fixes that.
- [ ] **Settle the allowance.** Log in to Ichabod's ChatGPT Plus account with Pi's device code login, pick the models for each job and give `run` a `--model` per pass, and prove `usage` works headless. Run the crontab for a day, then a day with workers, and check whether either hits the 5-hour or weekly limit. Workers on the strongest model are where the usage lives.
- [ ] **Stand up the board.** Kanboard on the Synology with the `ichabod` user and token, two-factor on Zach's own login, the plugin installer off, and columns triage, backlog, ready, running, review, blocked, done. `board createTask` works from inside Pi's `bash`.
- [ ] **Prove `send-mail`** with a real email arriving with the right envelope sender, and a `--in-reply-to` reply threading under the original in Gmail. Its rules are unit tested in `tests/`; the real mailbox is not.
- [ ] **Write `route.md` and delete `director.md`.** `director.md` is still written against the old workboard CLI. Carry over what it learned: read `backlog` before concluding there is nothing to do, dispatch one build-heavy card at a time, treat a `running` card that has not moved in an hour as stuck, close `review` only on work actually watched, and check `MEMORY.md` against its band. Add the `usage` check from [Models and usage](#models-and-usage) before a `wild-work` card moves to `ready`, and have `scout.md` skip its proposal at the same threshold. Drop the projection one-liner and the twin-card workaround, since Kanboard returns small results and tasks can be edited in place.
- [ ] **Write `work.md`.** Uncomment the `route` and `work` lines in `home/crontab` once both prompts exist.
- [ ] **Check `scout.md` and `digest.md`** against the real board, after [#68](https://github.com/zfleeman/ichabod-crane/issues/68) decides whether strangers' issues reach `scout` at all.
- [ ] **Prove the membrane.** `receive-mail` and `membrane.md` are written to [MEMBRANE.md](MEMBRANE.md) but have never touched a real mailbox or model. They need a working `send-mail`, and `pi` resolvable on `PATH=/usr/bin`. The gate, the DMARC check and the output validator are unit tested in `tests/`; the model and the mailbox are not. Confirm Pi reads piped stdin alongside `@membrane.md` in `-p` mode, and that a filed message lands in `Archive`. All four of [its tests](MEMBRANE.md#how-to-test-it) pass before the `receive-mail` line in `home/crontab` is uncommented.
- [ ] **Clone the fork.** `ich4bod/ichabod-crane` into `src/ichabod-crane`, with `upstream` pointing at `zfleeman/ichabod-crane`, as the `proposing-changes` skill expects.
- [ ] **Write `health`,** and prove it shouts when a pass has not succeeded. How it shouts when mail is broken is [#69](https://github.com/zfleeman/ichabod-crane/issues/69).

### Prove it

- [ ] **End to end.** `make cron`, then pass [the acceptance test](ICHABOD-GUIDE.md#touchpoints) with a small website idea. Scheduled work survives a host reboot.
- [ ] **Rehearse recovery.** Restore one application backup into a disposable instance, and have Zach run every kill switch in [the guide](ICHABOD-GUIDE.md#kill-switches) in order rather than trusting that it is written down.
- [ ] **EBS snapshots.** Add a lifecycle policy to `tofu/`; the guide relies on one and none exists yet.
- [ ] **Session Manager logging.** Decide whether to log sessions to S3 or CloudWatch Logs so administrative access is auditable, and add it to `tofu/` if so.
- [ ] **Move this list into issues.** Once the migration pull request merges, file an issue for each item still open here, and delete this section.

### Things to figure out

- Which OpenAI model does each job, and does Plus cover the crontab and the workers or does it need Pro?
- Is one Kanboard project with columns enough, or does `route` want swimlanes per kind of work?
- Is `t3a.large` still the right size? It was chosen when the box also ran a Node gateway and a sandbox image.
