# Runtime

Why the agent runtime on the box is built the way it is: Pi, cron, memory, the board, and mail. The machine underneath is [ICHABOD-GUIDE.md](ICHABOD-GUIDE.md), and the mail boundary is [MEMBRANE.md](MEMBRANE.md). What each script does is in its header comment; this document only covers the choices behind them.

The goal is a box one person can understand all at once: a few shell scripts, a crontab, prompt files, and `pi`. No daemon, no plugins, no dashboard, nothing to keep alive.

## Why Pi and cron

**The preamble is the cost.** Every turn re-sends everything the model was handed before it started, so tokens spent on the framework come out of the same allowance as the real work. A routing pass under the previous harness carried 38,831 tokens before its first action, about a third of it a system prompt nobody here controlled. Pi is four tools and a short system prompt, so the preamble is almost entirely our own words.

**Nothing may quietly weaken the trust boundary.** Under Pi the membrane is a process started with no tools and an empty environment, not a configuration setting. That is something you can check by trying to break it.

**One user, one schedule.** `ichabod` runs every pass and the membrane. [MEMBRANE.md](MEMBRANE.md#what-we-deliberately-gave-up) covers what running the membrane under the same user costs. The shipped schedule lives in `/etc/cron.d` so Ichabod's own crontab stays his, and `make deploy` never installs it, so a deploy can't re-enable a pass that a kill switch turned off.

## Passes

Each pass is one prompt file in `home/prompts/`, run by `run` from cron. The prompt file is the definition of the pass.

**Reasoning goes on the card as a comment.** The board is both the queue and the record, so the journal only holds what does not belong to a card.

**`route` and `work` are separate passes because they run on different models.** Pi takes one `--model` per run, so a single "read the board, do the next thing" loop would route and build on the same model. Merge them only if one model turns out to be right for both.

## Memory

Every run starts with an empty context. Pi loads `workspace/AGENTS.md` by itself, and the agent reads everything else on purpose, with `read` or `grep`, when the work calls for it. That keeps the preamble small, and it means the file layout is the memory design. `AGENTS.md` holds the exact rules, because it is the one file the agent is guaranteed to see.

**A fact moves up as it proves it will last.** It starts as a comment on a card or a journal entry. When it will still matter in a month, it becomes one line in `MEMORY.md`, and the detail stays behind.

**Only one `AGENTS.md` may exist.** Pi looks for `AGENTS.md` in `~/.pi/agent/`, in every parent of the directory it starts in, and in that directory. Creating `/home/ichabod/AGENTS.md` would silently add to every run's preamble.

**The journal is a folder per day, read one entry at a time.** A file a pass opens is re-sent on every later turn of that run, so one large journal file can spend the whole usage limit. A day is a short contents page plus one file per entry, and a pass opens only the entries it needs.

**The journal is flat by day, on purpose.** The ISO date in each name already sorts by year, month and day, and `MEMORY.md` is the long-range summary, so there are no month folders or rollups to keep in sync. Nothing deletes old days, because a day nobody opens costs nothing.

`log/` is not memory. The passes read `cost.jsonl` and `usage.jsonl` from it, and the per-run transcripts are for Zach.

## How passes run

**Passes use `--mode json`.** `-p` prints only the final message, with no token counts and no record of tool calls. JSON mode makes the log file and the event stream the same thing, so there is no separate logging to write. The membrane uses `-p` for a different reason, covered in [MEMBRANE.md](MEMBRANE.md#step-2--read-with-nothing).

**Nothing uses RPC mode.** RPC keeps a live session open for an orchestrator that steers mid-turn. A client that owns the process lifecycle is a daemon, which is what this design avoids. Revisit it only if a pass needs to be interruptible.

**Passes run with `--no-session`.** The JSON log already records every message and tool call. What is lost is reopening a finished pass to ask why it did something. `--session-dir /home/ichabod/log/sessions` would bring that back, at the cost of a second copy of every run on disk.

**Skill folders are passed explicitly.** Pi ignores project-local skill folders in `--mode json` unless the project is trusted, so `run` names Zach's `skills/` and Ichabod's `own-skills/` and loads nothing global.

**Never pass a prompt through `sudo -iu`.** The `-i` login shell re-parses the command line, so the backticks in a Markdown prompt get executed. Cron runs as `ichabod` and needs no `sudo`.

## Health

**Mail can be what broke, so `health` does not email.** A revoked app password, a Fastmail outage or the send cap would silence the very message saying so. Instead, each job's success becomes a CloudWatch heartbeat, and an alarm in `tofu/main.tf` emails through SNS when one goes quiet. Missing data counts as failing, so a dead box, a stopped cron, a broken `health` and a broken `send-mail` all show up the same way.

Ichabod is root-equivalent and could publish a fake heartbeat. That is accepted, like everything else he could fake.

## Models and usage

Ichabod runs on OpenAI models through a ChatGPT Plus subscription on his own account, logged in with Pi. The bill is flat, so the real limit is the subscription's 5-hour and weekly usage windows.

**The strongest model builds; a mid-tier model routes.** The smallest tier is not used for routing, because triage is a judgment call on text an attacker can influence, and getting it wrong is destructive.

**Two numbers stand in for the usage page**, which nothing on the box can read. `run` records tokens per run in `log/cost.jsonl`, which shows how hard each run worked. `usage` records percent of the allowance used in `log/usage.jsonl`, which shows how much room is left. `usage` calls an undocumented endpoint, so it fails loudly and its heartbeat stops when the endpoint changes, rather than leaving a quiet gap in the log.

## The board

**Kanboard at `ichabod-board.zfleeman.com`, hosted on Zach's Synology, reached by the `board` shell wrapper over JSON-RPC. Not over MCP.** MCP tool schemas are exactly the preamble cost Pi was chosen to remove. The wrapper costs nothing, because `bash` is already one of Pi's tools. It is also easy to debug: run `board getAllTasks '{"project_id":1}'` in a shell and see exactly what the agent sees.

**Ichabod logs in as his own Kanboard user**, with that user's API token rather than the global `jsonrpc` token, so his comments and moves are attributed to him and his token can be revoked on its own. That user is an admin, which brings two rules:

- Zach uses his own admin account, with two-factor login, because it is an admin login on a public hostname. If Ichabod breaks it, Zach resets it from the Kanboard container, which Ichabod cannot reach.
- The plugin installer is off. Kanboard plugins are PHP, so an admin who can install one can run code on the Synology, outside Ichabod's boundary.

**Why the Synology and not the box.** The board needs a public HTTPS endpoint either way, and the Synology's reverse proxy already has one. Hosting it there keeps Ichabod's Docker authority, including `system prune` and volume removal, away from the board, and the board survives a rebuild. The accepted risk is home network and power uptime.

**The wrapper is the seam.** Every prompt calls `board <verb>`, so moving to a different board means rewriting one script. If Kanboard becomes a nuisance, the fallbacks in order are GitHub Issues with labels, SQLite, then Markdown files.

## Mail

**In** is `receive-mail`, the only safety-critical path on the box. [MEMBRANE.md](MEMBRANE.md) is its specification.

**Out** is `send-mail`. Its rules live in the script rather than a prompt, so no email or card can widen them.

**There is no search or archive command, on purpose.** A search command would let an agent with tools read message bodies, which is exactly what the membrane exists to prevent. Replying needs only the original `Message-ID`, and `receive-mail` writes it onto every card. It uses the `Message-ID` header, never the IMAP UID, because a UID changes when a message moves between folders.

## Trade-offs this design accepts

- **No model fallback.** A provider outage fails the pass, and the next scheduled run tries again.
- **No dashboard.** Kanboard shows the board, and everything else is `jq` over `log/`. If that gets old, switch to `--session-dir` and `pi --export` turns any run into a web page.
- **Shell and Python instead of typed plugins.** Easier to read, and easier to get subtly wrong.
- **A new pass is a prompt file and a cron line.** Smaller, and less interesting, than a multi-agent framework.
- **Secrets are not hidden from the model.** A variable sourced from the env file is one `env` call away from a transcript. `ichabod` is root-equivalent regardless, and the membrane, the one process that is not trusted, inherits none of them.
