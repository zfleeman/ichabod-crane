# Automations

The three recurring passes. The files here are the source of truth: `scripts/deploy-workspace` copies them to `/srv/ichabod/automations` on the box, and `scripts/configure-automations` registers them with the Gateway's scheduler.

| File | Job | Schedule |
|---|---|---|
| `director.md` | Reads the board, triages, dispatches one card, recovers stale claims, retires superseded intake cards | Every 30 minutes |
| `scout.md` | Proposes at most one `wild-work` card | 06:00, 11:00, 16:00, 21:00 America/Denver |
| `digest.md` | One email to Zach, or silence | Daily, 07:00 America/Denver |

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

So the prompts send the written record to the day's journal — `memory/YYYY-MM-DD.md`, which Ichabod owns and can append to — keyed by card id. The board holds status; the journal holds reasoning.

### Why an emailed request costs two cards

`triage-guard` strips `agentId` from any card the mail reader creates, which is the whole point: an email must not be able to assign work to the agent that can do anything. But `dispatch` will not start an unassigned card, and `move` cannot add an owner afterwards — `create --agent` is the only place an owner can be set. So the intake path and the dispatch path do not meet, and the director's workaround is to re-create each intake card as an owned twin and dispatch that.

The cost is a duplicate card per emailed request, and the trap is what happens to the original: it goes to `backlog`, and for a while nothing took it out again. Seven of them accumulated in one day, each one a finished request that read as unstarted work. The director prompt now closes the intake card in the same pass that closes its twin.

The real fix is upstream, and it is not built: either a per-board default owner, or `move` learning `--agent` the way `create` has it. Until one of those exists, expect the twins.

## Things that cost time to discover

- **`--agent` is applied on create and ignored on a `--declaration-key` update.** A job updated in place keeps whatever owner it had, and a job with no owner fails every run with `AGENT_SELECTION_REQUIRED`. `configure-automations` removes and recreates for exactly this reason.
- **Delivery defaults to a chat channel this box does not have.** Without `--no-deliver` a job fails closed on delivery even when the work succeeded. That is what the stock `heartbeat:ichabod` job had been doing, unnoticed, for forty consecutive runs — `configure-automations` disables it.
- **`automations get` and `rm` take an id, not a name.** `automations list --json` is how you turn one into the other.
- **A main-session job cannot carry `--message`** — the CLI insists on `--system-event` or `--script` — and it rejects `--no-deliver` too. A director built that way enqueued and then never produced a run, so all three passes are isolated sessions instead. Each one reads the board first, so none of them needs continuity from the last.
- **Pass prompts through `sudo -u`, never `sudo -iu`.** The `-i` login shell re-parses the command line, so a Markdown prompt handed over as one argument has its backticks executed on the box and its blank lines flattened. That is not hypothetical: it ran `openclaw workboard dispatch` and baked the entire board into a job's message.
- **`dispatch` needs `--admin` for any card the CLI created.** CLI-created cards default to restricted workspace access, and a restricted card refuses to start on `ichabod`, which is not sandboxed: `target agent is not sandboxed for this restricted Workboard card`. Pair it with `--max-starts 1` — plain `dispatch` promotes every `ready` card at once and defaults to three.
- **The stock heartbeat cannot be turned off.** `automations rm` and `disable` both refuse ("system-owned monitor jobs cannot be edited by cron clients"), and removing `agents.defaults.heartbeat` from the config does not remove the job either — it is persisted in the scheduler's store and survives a Gateway restart. Expect a `skipped` line in the history every 30 minutes and read past it.
