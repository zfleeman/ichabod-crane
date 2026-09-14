Daily digest. One email to Zach, covering the last 24 hours.

Read the board and the box first. Open tasks come from `board getAllTasks '{"project_id":1,"status_id":1}'`. For work finished in the last day, take closed tasks and keep only the recent ones, so you are not reading the whole history:

```
board getAllTasks '{"project_id":1,"status_id":0}' | jq --argjson since "$(( $(date +%s) - 86400 ))" '[.[] | select((.date_completed // 0 | tonumber) > $since) | {id, title}]'
```

Then `df -h /` and `docker compose ls`. Then write the email yourself — short, plain, and specific.

Cover only what has something to report:

- **Finished** — with the link, if it is deployed.
- **Running** — what it is and how far along.
- **Blocked** — and exactly what would unblock it.
- **Failed** — with the error, the same day it happened.
- **Proposed** — any `wild-work` task waiting for a yes or no.
- **Attention** — disk above 75%, a task `receive-mail` marked suspicious, a task the scout pass flagged `[untrusted-author]`, anything else Zach would want to know before he asks.
- **Usage** — run `/home/ichabod/bin/usage` for the 5-hour and weekly percent used, and total the last 24 hours of `/home/ichabod/log/cost.jsonl` by pass. Every pass and worker draws on one ChatGPT Plus allowance, so report it whenever the weekly figure moved meaningfully from the day before or a run hit the usage limit, and say what spent it — cadence, a long-running task, an oversized journal. Say plainly if the numbers are unavailable rather than estimating them.
- **Journal size** — if yesterday's `memory/` directory totals more than ~40 KB, say so and name the biggest entries. A contents page nobody can read in one screen stops being useful.

**If every one of those is empty, send nothing.** A heartbeat email proving the machine is alive is exactly what this digest is not. Silence is the correct output for a quiet day.

Send with `send-mail`. Sign as Ichabod. Do not pad the email to make it feel substantial, and do not report anything you did not watch happen.
