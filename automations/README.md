# Automations

The three recurring passes. The files here are the source of truth: `scripts/deploy-workspace` copies them to `/srv/ichabod/automations` on the box, and `scripts/configure-automations` registers them with the Gateway's scheduler.

| File | Job | Schedule |
|---|---|---|
| `director.md` | Reads the board, triages, dispatches one card, recovers stale claims | Hourly |
| `scout.md` | Proposes at most one `wild-work` card | Daily, 09:00 America/Denver |
| `digest.md` | One email to Zach, or silence | Daily, 07:00 America/Denver |

## What the director's cadence actually costs

The IMAP watcher is event-driven — `watch: {mode: "auto", pollSeconds: 60}` — so an email becomes a triage card within about a minute of arriving. But nothing dispatches a card on its own, so the director's schedule *is* how long a request waits. Hourly means a card can sit for up to an hour next to a reader that produced it in one minute. That is the deliberate trade: 24 model sessions a day instead of 288, most of which would find an empty board.

If that hour ever feels long, the fix is a condition script rather than a tighter schedule — see below.

## The condition script, and why it is not here yet

`automations add` takes `--trigger-script`, which decides per check whether the job actually runs. That would give quick response without paying for a model session every five minutes. It is not built, because the runtime contract took longer to establish than the feature is currently worth. What is known, so the next attempt starts further along:

- **It is JavaScript, not shell.** A shell line fails with `Invalid regular expression flag`, because the engine parses `/tmp/x.log` as a regex literal.
- **It returns `{ fire, message?, state? }`.** `state` persists across checks even when `fire` is false, and lands in the job's `state.triggerState` — which is also the easiest way to debug one. A `message` is appended to the agent's turn when it fires.
- **The whole tool surface is in scope as globals**, including `exec`, `process`, `read`, `mailbox_search`, `memory_get` and `automations`. There are no `workboard_*` tools among them.
- **`exec` takes an object and returns a handle, not output.** `await exec({ command: "..." })` resolves to `{status: "running", sessionId, pid, ...}`, so reading a command's output means polling `process` and then reading a file. That is the part that needs working out.
- **Tool-argument errors escape `try`/`catch`** and fail the whole evaluation.
- **A watcher that goes quiet when its own check breaks looks exactly like a watcher with nothing to do.** Whatever gets built should fire on a failed check and say so, rather than staying silent.

## Things that cost time to discover

- **`--agent` is applied on create and ignored on a `--declaration-key` update.** A job updated in place keeps whatever owner it had, and a job with no owner fails every run with `AGENT_SELECTION_REQUIRED`. `configure-automations` removes and recreates for exactly this reason.
- **Delivery defaults to a chat channel this box does not have.** Without `--no-deliver` a job fails closed on delivery even when the work succeeded. That is what the stock `heartbeat:ichabod` job had been doing, unnoticed, for forty consecutive runs — `configure-automations` disables it.
- **`automations get` and `rm` take an id, not a name.** `automations list --json` is how you turn one into the other.
