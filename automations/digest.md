Daily digest. One email to Zach, covering the last 24 hours.

Read the board and the box first: `openclaw workboard list --json`, `df -h /`, `docker compose ls`. Then write the email yourself — short, plain, and specific.

Cover only what has something to report:

- **Finished** — with the link, if it is deployed.
- **Running** — what it is and how far along.
- **Blocked** — and exactly what would unblock it.
- **Failed** — with the error, the same day it happened.
- **Proposed** — any `wild-work` card waiting for a yes or no.
- **Attention** — disk above 75%, a card carrying a `[triage-guard]` line, anything else Zach would want to know before he asks.
- **Quota** — run `python3 scripts/claude_usage_footer.py` and report the session and weekly figures. This is Zach's own Claude account, and every pass and every worker spends it, so he is the one who gets throttled when the box has a busy day. Report it whenever the weekly figure has moved meaningfully or the session limit was hit in the last 24 hours, and say what spent it — cadence, a long-running card, an oversized journal. Say plainly if the numbers are unavailable rather than estimating them.
- **Journal size** — if yesterday's `memory/` directory totals more than ~40 KB, say so and name the biggest entries. That file gets re-read by every pass, so it is the one number that quietly multiplies everything else.

**If every one of those is empty, send nothing.** A heartbeat email proving the machine is alive is exactly what this digest is not. Silence is the correct output for a quiet day.

Send with `smtp_send`. Sign as Ichabod. Do not pad the email to make it feel substantial, and do not report anything you did not watch happen.
