# Automations

The three recurring passes. The files here are the source of truth: `scripts/deploy-workspace` copies them to `/srv/ichabod/automations` on the box, and `scripts/configure-automations` registers them with the Gateway's scheduler.

| File | Job | Schedule | Model |
|---|---|---|---|
| `director.md` | Reads the board, triages, dispatches one card, recovers stale claims, retires superseded intake cards | Every 30 minutes | Sonnet 5 |
| `scout.md` | Proposes at most one `wild-work` card | 06:00, 11:00, 16:00, 21:00 America/Denver | Sonnet 5 |
| `digest.md` | One email to Zach, or silence | Daily, 07:00 America/Denver | Sonnet 5 |

The passes run on Sonnet, not the agent's Opus default, because they route and write rather than build. Dispatched workers still get Opus — see below for why the model choice is a quota decision rather than a quality one.

## What a pass costs, and why the model matters

This is a Claude **Pro** subscription: one shared five-hour bucket, no separate Opus bar. Measured on 2026-09-09, that bucket is roughly 25M input+cache tokens — 5.8M of it read as 21% used.

Against that, the director's cadence is the dominant line item. Ten passes per window at Opus prices came to about 15M, over half the budget, before a single worker ran. Opus costs roughly 2.5x Sonnet at list rates, so moving the passes to Sonnet takes that to about 6M and leaves real headroom for the work.

The rule of thumb: a pass that routes, triages and writes runs on Sonnet; a dispatched worker that builds something gets Opus. Haiku was considered for the director and rejected for now — step 3 is an injection call on attacker-controlled email text, and step 7 retires cards on documentary evidence. Both are judgment, and both fail destructively.

## What the director's cadence actually costs

The IMAP watcher is event-driven — `watch: {mode: "auto", pollSeconds: 60}` — so an email becomes a triage card within about a minute of arriving. But nothing dispatches a card on its own, so the director's schedule *is* how long a request waits. At 30 minutes a card can sit for half an hour next to a reader that produced it in one minute. That is the deliberate trade: 48 model sessions a day instead of 288, most of which would find an empty board.

These schedules drift, because Zach changes them by email and a worker card applies the change to the live scheduler. `configure-automations` removes and recreates every job, so a value left stale in that script silently reverts a change someone asked for. When you edit a schedule on the box, edit the script in the same commit.

If that half-hour ever feels long, the fix is a condition script rather than a tighter schedule — see below.

## The condition script, and why it is not here yet

`automations add` takes `--trigger-script`, which decides per check whether the job actually runs. That would give quick response without paying for a model session every five minutes. It is not built, because the runtime contract took longer to establish than the feature is currently worth. What is known, so the next attempt starts further along:

- **It is JavaScript, not shell.** A shell line fails with `Invalid regular expression flag`, because the engine parses `/tmp/x.log` as a regex literal.
- **It returns `{ fire, message?, state? }`.** `state` persists across checks even when `fire` is false, and lands in the job's `state.triggerState` — which is also the easiest way to debug one. A `message` is appended to the agent's turn when it fires.
- **The whole tool surface is in scope as globals**, including `exec`, `process`, `read`, `mailbox_search`, `memory_get` and `automations`. There are no `workboard_*` tools among them.
- **`exec` takes an object and returns a handle, not output.** `await exec({ command: "..." })` resolves to `{status: "running", sessionId, pid, ...}`, so reading a command's output means polling `process` and then reading a file. That is the part that needs working out.
- **Tool-argument errors escape `try`/`catch`** and fail the whole evaluation.
- **A watcher that goes quiet when its own check breaks looks exactly like a watcher with nothing to do.** Whatever gets built should fire on a failed check and say so, rather than staying silent.

## What the passes can actually do to a card

`openclaw workboard` offers `list`, `show`, `create`, `move` and `dispatch`. **`move` takes a status and nothing else, and notes can only be set at creation**, so no pass can annotate a card that already exists. The first live director run showed what that costs if you ignore it: it moved a card to `done` and left behind no record of what it had checked.

So the prompts send the written record to the day's journal, which Ichabod owns and can append to, keyed by card id. The board holds status; the journal holds reasoning.

### The journal is a directory, and this is why

`memory/YYYY-MM-DD/` holds one file per pass or per card — `21-1624-director.md`, `22-1628-card-5e0f139c.md`. The leading number is the entry's position in the day, and it is load-bearing: several headings carry no clock time, so without it the directory sorts out of chronological order. That was caught by checksumming the rejoined entries against the original, which is the only reason it did not ship. `memory/YYYY-MM-DD.md` survives as that day's contents page: one line per entry, a couple of KB at most. Keeping the daily `.md` as a real file is deliberate — the bundled memory plugins glob `memory/*.md`, and turning that path into a directory would have been an unforced change to something we do not own.

It used to be one file per day, and `AGENTS.md` said "it is fetched on demand, so length costs nothing until something asks for it." That was wrong twice over. Something asks for it every pass, and an opened file does not cost once — it stays in the session and is re-sent on every turn after it.

Measured on 2026-09-09, in the five-hour window 14:10–19:09 UTC:

| | |
|---|---|
| `memory/2026-09-09.md` | 101,779 bytes (~25–30K tokens) |
| Agent sessions in the window | 14 |
| Sessions carrying journal text | 14 of 14 |
| Input + cache tokens, box only | 22,591,784 |
| Output tokens | 241,716 |
| Result | account session limit 100% consumed |

The 15:00 hour alone burned 12.7M tokens — that was the hour the director briefly ran every 15 minutes.

**The conclusion originally drawn from this table was wrong, and it is worth saying why.** This section used to end "cadence multiplies the journal; the journal is what makes cadence expensive," and that sentence propagated into `AGENTS.md`, `director.md` and `digest.md`, so the next investigation into context pressure started at the journal and found nothing. Measured on 2026-09-10 across 76 director passes:

| | tokens |
|---|---|
| Fixed preamble, before a pass does anything (median) | **47,721** |
| Peak context reached (median) | 58,078 |
| Work a pass adds to its own baseline (median) | ~10,400 |
| Everything the pass reads out of `memory/` | ~1,650 (**2.8%**) |

Cumulative input across those 76 sessions was 62.5M tokens, of which the 47.7k baseline re-sent every turn accounts for ~40M and journal reads ~1.4M. A controlled A/B on two identical throwaway cron probes located the baseline: `--tools "*"` costs 42,278 tokens and `--tools "exec,read,write,edit"` costs 10,161, so **~32,000 tokens of every pass is tool schemas**. For scale, a bare `claude -p` in this workspace is 19,312.

So cadence is still the lever — 48 passes a day at ~48k fixed each is the bill — but it multiplies the *preamble*, not the journal. Narrowing `--tools` is the order-of-magnitude fix and is **not yet safe**: it strips the claude-cli harness's native Bash/Read/Write/Edit and substitutes OpenClaw's own `exec`, which backgrounds long commands and returns "still running, pid N". A live director pass on the narrowed list dropped to an 11,983 baseline and then spent 14 turns in a sleep-and-poll loop without reaching a routing decision. It needs either a tool-name list that keeps the native harness tools or a director prompt written against the async `exec` contract. Full working in `memory/2026-09-10/36-1615-card-27de693e.md`.

**The rule that follows: never open a whole day.** Read the contents page, open only the entries you need, and refer to a standing decision by its entry name rather than re-reading and restating it.

There is a second-order fix worth knowing about. The journal is fat because `openclaw workboard move` cannot annotate a card, so reasoning that belongs on a card ends up in a file every session reads. If `workboard.cards.update` works (see above), most of this moves onto the cards themselves and each session reads only the one card it is working.

### Why an emailed request costs two cards

`triage-guard` strips `agentId` from any card the mail reader creates, which is the whole point: an email must not be able to assign work to the agent that can do anything. But `dispatch` will not start an unassigned card, and `move` cannot add an owner afterwards — `create --agent` is the only place an owner can be set. So the intake path and the dispatch path do not meet, and the director's workaround is to re-create each intake card as an owned twin and dispatch that.

The cost is a duplicate card per emailed request, and the trap is what happens to the original: it goes to `backlog`, and for a while nothing took it out again. Seven of them accumulated in one day, each one a finished request that read as unstarted work. The director prompt now closes the intake card in the same pass that closes its twin.

### A likely way out, not yet verified

The CLI is not the whole surface. The Gateway registers `workboard.cards.update` under the write scope, and `openclaw gateway call <method> --params <json>` can reach it from a shell on the box. The handler's `readPatch` passes the patch object straight through to the store rather than filtering it to a fixed field list, so this should assign an existing card:

```bash
openclaw gateway call workboard.cards.update \
  --params '{"id":"<card-id>","agentId":"ichabod"}'
```

If that works, the twin goes away entirely: the director assigns the intake card and dispatches it in place.

**This has not been run.** It is read off the shipped JavaScript, which is exactly the kind of evidence this project has learned not to trust — `config validate` and `sandbox explain` were both read-correct and wrong. Verify it against a live card before putting it in `director.md`, and check what it does to the card's `workspaceAccess`, since the handler strips that field from the patch and `dispatch --admin` exists precisely because restricted cards will not start on `ichabod`.

The alternative fix, if that one does not pan out, is a per-board default owner. The Control UI has a "Default agent" label and the bundle carries a `defaultAgentId`, but nothing in the server-side extension code references it, and the workboard plugin config on the box is bare `{"enabled": true}` — so it may be UI-only. Until one of the two is confirmed, expect the twins.

## Things that cost time to discover

- **`--agent` is applied on create and ignored on a `--declaration-key` update.** A job updated in place keeps whatever owner it had, and a job with no owner fails every run with `AGENT_SELECTION_REQUIRED`. `configure-automations` removes and recreates for exactly this reason.
- **Delivery defaults to a chat channel this box does not have.** Without `--no-deliver` a job fails closed on delivery even when the work succeeded. That is what the stock `heartbeat:ichabod` job had been doing, unnoticed, for forty consecutive runs — `configure-automations` disables it.
- **`automations get` and `rm` take an id, not a name.** `automations list --json` is how you turn one into the other.
- **A main-session job cannot carry `--message`** — the CLI insists on `--system-event` or `--script` — and it rejects `--no-deliver` too. A director built that way enqueued and then never produced a run, so all three passes are isolated sessions instead. Each one reads the board first, so none of them needs continuity from the last.
- **Pass prompts through `sudo -u`, never `sudo -iu`.** The `-i` login shell re-parses the command line, so a Markdown prompt handed over as one argument has its backticks executed on the box and its blank lines flattened. That is not hypothetical: it ran `openclaw workboard dispatch` and baked the entire board into a job's message.
- **`dispatch` needs `--admin` for any card the CLI created.** CLI-created cards default to restricted workspace access, and a restricted card refuses to start on `ichabod`, which is not sandboxed: `target agent is not sandboxed for this restricted Workboard card`. Pair it with `--max-starts 1` — plain `dispatch` promotes every `ready` card at once and defaults to three.
- **A pass's prompt lives in two places, and they drift.** `configure-automations` bakes the file into the scheduler job with `--message`, so the job holds a *copy*. Editing the live job takes effect immediately and is silently reverted the next time anyone runs the script; editing the file here changes nothing until someone deploys. On 2026-09-10 the director's board projection and the digest's corrected journal-size bullet existed only inside the jobs for several hours — one `configure-automations` run would have erased both with no diff and no error. Check with `openclaw automations get <id> --json` and compare `payload.message` against the file. Fix the file, commit, then deploy.
- **The stock heartbeat cannot be turned off.** `automations rm` and `disable` both refuse ("system-owned monitor jobs cannot be edited by cron clients"), and removing `agents.defaults.heartbeat` from the config does not remove the job either — it is persisted in the scheduler's store and survives a Gateway restart. Expect a `skipped` line in the history every 30 minutes and read past it.
