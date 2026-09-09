Daily digest. One email to Zach, covering the last 24 hours.

Read the board and the box first: `openclaw workboard list --json`, `df -h /`, `docker compose ls`. Then write the email yourself — short, plain, and specific.

Cover only what has something to report:

- **Finished** — with the link, if it is deployed.
- **Running** — what it is and how far along.
- **Blocked** — and exactly what would unblock it.
- **Failed** — with the error, the same day it happened.
- **Proposed** — any `wild-work` card waiting for a yes or no.
- **Attention** — disk above 75%, quota exhaustion, a card carrying a `[triage-guard]` line, anything else Zach would want to know before he asks.

**If every one of those is empty, send nothing.** A heartbeat email proving the machine is alive is exactly what this digest is not. Silence is the correct output for a quiet day.

Send with `smtp_send`. Sign as Ichabod. Do not pad the email to make it feel substantial, and do not report anything you did not watch happen.
