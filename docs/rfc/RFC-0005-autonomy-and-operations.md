# RFC-0005 — Autonomy, operations, and recovery

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Scope** | The recurring automations that make the system autonomous, the capacity ceilings, and the backup, update, kill-switch, and completion criteria. |
| **Source** | Sections 12 and 14 of [ICHABOD-GUIDE.md](../ICHABOD-GUIDE.md), copied without rewording |
| **Related** | [RFC-0001](RFC-0001-foundations.md), [RFC-0004](RFC-0004-agent-runtime.md) |

## Persistent autonomy

The system becomes autonomous when durable state, scheduled attention, and broad tools are joined by a clear mission.

### Workboard as the durable mind

Every substantial task should become a card. The card, repository, and application state must be enough for a fresh session to continue without rereading an enormous transcript.

Before a run ends or quota is exhausted, checkpoint:

- current status and next action
- repository, branch, and commit
- uncommitted changes
- tests run and their results
- deployment URL and container state
- decisions, blockers, and external operation IDs

Context replacement then becomes normal maintenance rather than amnesia.

### Three recurring passes

Start with three automations:

#### Director pass

Run every 15–30 minutes while the experiment is active:

- Review triage, ready, running, review, and blocked cards.
- Clarify and decompose new Zach requests.
- Choose the highest-value eligible card.
- Respect one-heavy-worker concurrency.
- Dispatch or continue work.
- Recover stale claims.
- Checkpoint before stopping.

#### Scout pass

Run once daily:

- Look for a useful project connected to Zach's interests.
- Create at most one `wild-work` proposal.
- Include a hypothesis, timebox, cost, acceptance test, and kill condition.
- Do not crowd out Zach's requested work.

#### Digest

Send Zach one concise daily email:

- completed with links
- running
- blocked and why
- failed
- proposed Wild Work
- disk/quota concern requiring attention

Do not send a heartbeat email merely to prove the machine is alive.

OpenClaw automations should own the schedules and run history. Current OpenClaw no longer treats a workspace `HEARTBEAT.md` as the primary place for recurring instructions; keep automation instructions with the job or its current scratch/configuration. See [OpenClaw automation documentation](https://docs.openclaw.ai/automation).

### Capacity policy

A good starting allocation is:

- 60% Zach-requested work.
- 20% maintenance and improvements that compound.
- 20% self-directed Wild Work.

Twenty percent is a real budget rather than a rounding error, which changes what Wild Work can be: not only one-off experiments, but standing work that compounds.

**The blog.** Publish a few posts a week at `blog.ichabod-crane.net` — a static site Ichabod builds and deploys like any other app, written from what actually happened rather than invented topics. The material is already there: the Workboard card, the commits, the tests that failed first, the decision that turned out wrong. A post per finished card, plus the occasional note on something learned while fixing the machine itself.

It earns its 20% for a practical reason beyond being enjoyable to read. A system that has to explain its work in public produces a written record of decisions, and that record is the thing a fresh session reads when the context is gone. It is the memory discipline with an audience attached.

Two rules keep it honest: post about work that is genuinely finished and verifiable, and never invent a result to have something to publish. A week with nothing worth saying is a week with no posts.

Operational ceilings:

- One heavy build/browser worker at a time.
- No more than five experimental services initially.
- Default container limit of 0.5 CPU and 512 MiB.
- Finite timeout and retry budget on every automated card.
- Stop proposing new work when disk exceeds 75%.
- Back off when Claude quota is exhausted rather than switching secretly to metered API usage.

**Where each ceiling actually lives.** None of these is a single OpenClaw setting, which is worth knowing before hunting for one:

| Ceiling | Enforced by | Where |
|---|---|---|
| One heavy worker | Automation logic in the director pass | The director's own prompt and its card query |
| Five experimental services | Convention, checked by the director | `AGENTS.md`, verified with `docker compose ls` |
| 0.5 CPU / 512 MiB | Docker | `cpus` and `mem_limit` in each app's `compose.yaml` |
| Timeout and retry budget | Workboard card fields | Per-card, set when the card is written |
| Disk stop at 75% | Alarm plus director check | CloudWatch agent alarm ([RFC-0001](RFC-0001-foundations.md#alarms)) and `df -h` in the pass |
| Quota back-off | Claude Code, surfaced to the agent | Nothing to configure; the runtime reports exhaustion |

Only the container limits are enforced by machinery that cannot be talked out of it. The rest are policies Ichabod follows because `AGENTS.md` says so — which is the honest position for a lab, but do not mistake them for guardrails.

These are scheduling policies, not approval gates. Ichabod is free to operate inside them.

### Creating new agents

Ichabod can decide that a task deserves a durable agent, for example a long-lived GPU-deal researcher with separate memory and instructions. Under `full` mode, supported typed creation can apply automatically.

For many projects, a new agent is unnecessary. A GPU-deal service can be:

- one repository
- one database of observed offers
- one recurring automation
- one Workboard card or project label
- optional public dashboard
- email notifications

Create a durable agent when separate personality, memory, routing, or tool policy adds value. Copy critical policy from the version-controlled workspace template, then customize its mission. New agents must not silently receive personal credentials that do not belong to their task.

### First experiments

Good early projects:

1. **GPU deal hunter:** collect offers, deduplicate, score real discounts, email only noteworthy changes, and optionally publish a dashboard.
2. **Weekly tiny game:** build and host one polished browser game with tests and a short retrospective.
3. **The blog:** stand up `blog.ichabod-crane.net` as a static site and publish a few posts a week drawn from finished cards — see [capacity policy](#capacity-policy).
4. **Project resurrection:** select an abandoned bot-owned repository, make it run, improve it, and publish a demo.
5. **Wild Work:** spend a fixed timebox making something Zach did not request, then either finish it or stop cleanly.
6. **Operations naturalist:** observe its own disk, container health, failed builds, and recurring friction; propose and implement small improvements.

The measure of autonomy is not how often the model acts. It is how often it notices, chooses, finishes, verifies, remembers, and reports useful work without manual recovery.

## Operations, recovery, and success criteria

### Zach's normal touchpoints

| Frequency | Touchpoint |
|---|---|
| Whenever inspiration strikes | Email Ichabod |
| Occasionally | Run `make ui` and inspect Workboard or sessions |
| Weekly | Review finished work, blocked cards, Wild Work, disk, and running services |
| Monthly | Review AWS cost, Claude quota, updates, backups, and stale applications |
| Rarely | `make shell` for upgrades, broken credentials, host recovery, or EC2 resizing |

You should not need to open a session for each site, add DNS records, map ports, obtain certificates, publish images, or restart the Gateway.

### Backups

Use four simple layers:

1. **GitHub:** source and history for every valuable project.
2. **OpenClaw backup:** Gateway state, Workboard, workspaces, and configuration.
3. **Application-native backups:** database dumps or volume archives for stateful apps.
4. **EBS snapshots:** recovery of the whole machine after host or volume loss.

Create and verify an OpenClaw backup:

```bash
openclaw backup create \
  --output /srv/ichabod/backups/openclaw \
  --verify
```

Copy important backups off the instance. A backup stored only on the failed volume is not a recovery plan.

Layer 3 means the applications **Ichabod builds and runs** — the Minesweeper site, the GPU-deal database, the blog, anything else that lands in `/srv/ichabod/apps/`. Their data lives in named Docker volumes that nothing else backs up: an EBS snapshot captures the volume's bytes but not a consistent database, and GitHub has the source but never the data. So for every stateful application Ichabod creates, its README must name:

- persistent volume or database
- backup command
- restore command
- retention
- last tested restore date

Writing that README is part of the definition of done for a stateful app, not a follow-up card.

Schedule EBS snapshots through a lifecycle policy — those are Zach's, taken by AWS, and never touched by anything on the box. Then perform at least one restore into a disposable instance. Snapshots may be crash-consistent, so take database-native dumps first when consistency matters. An untested restore is a hypothesis.

### Updates

Update one layer at a time:

1. Confirm a current backup.
2. Record the current version.
3. Read release notes.
4. Update.
5. Recheck Gateway, model auth, Workboard, IMAP, Traefik, Docker, and one public site.

For OpenClaw:

```bash
openclaw backup create --output /srv/ichabod/backups/openclaw --verify
openclaw update --dry-run
openclaw update
openclaw doctor
```

Pin Traefik and application base images. Let Ichabod propose or perform ordinary project dependency updates, but treat OpenClaw, Docker, the SSM agent, and Traefik as the workshop machinery and update them deliberately.

### Kill switches

From least to most severe:

1. Disable director/scout automations and IMAP ingestion.
2. Revoke outbound email and GitHub credentials.
3. Stop the Gateway:

   ```bash
   sudo -iu openclaw openclaw gateway stop
   ```

4. Stop one application:

   ```bash
   cd /srv/ichabod/apps/<slug>
   docker compose down
   ```

5. Stop the EC2 instance from Zach's AWS account.
6. If compromise is suspected, remove public ingress, revoke credentials, snapshot the disk, and investigate a copy.

Stopping EC2 does not stop EBS, snapshot, Elastic IP, domain, or other noncompute charges.

### Troubleshooting

| Symptom | First checks |
|---|---|
| `make shell` fails | Instance state, SSM ping status, instance profile, local AWS credentials, session-manager-plugin |
| Forward opens but UI does not | Gateway service, loopback listener, port conflict, Gateway auth |
| Claude fails | `claude auth status --text`, quota, CLI version, service `PATH` |
| Email creates no card | IMAP watcher, allowlist, DMARC evidence, baseline behavior, reader transcript |
| Duplicate mail card | Workboard idempotency key and IMAP message identity |
| Workboard does not dispatch | Gateway, card status, assignment, dependencies, worker policy, concurrency |
| App hostname does not resolve | Authoritative nameservers, apex/wildcard A records, Elastic IP |
| HTTPS fails | Ports 80/443, Traefik logs, router labels, ACME email/storage, DNS |
| Wrong app answers | Duplicate router name or hostname label, stale container |
| Container unhealthy | Bind address, internal port, health command, logs, memory/OOM |
| Host is slow | `free -h`, swap, CPU credits, concurrent workers, Docker limits |
| Disk fills | `docker system df`, logs, build cache, old images; preserve volumes |

### Completion criteria

Infrastructure:

- [ ] The instance is `t3a.large` or an intentionally chosen local equivalent.
- [ ] Disk is encrypted, budget alerts work, and 80/443 are the only inbound ports.
- [ ] Port 22 is closed and administration works only through SSM.
- [ ] Gateway 18789 and Docker API ports are not public.
- [ ] Apex and wildcard DNS resolve correctly.

Control plane:

- [ ] The Gateway is loopback-only and returns after reboot.
- [ ] Zach can reach the Control UI and Workboard through the documented SSM port forward.
- [ ] Claude uses the dedicated subscription and has no unintended metered-key fallback.
- [ ] Workboard survives reboot and shows linked execution history.
- [ ] OpenClaw's secret audit reports no supported plaintext credential residue.

Autonomy:

- [ ] `main` runs host commands and Docker without routine approvals.
- [ ] `main` can create a durable agent without Zach approving the operation.
- [ ] `mail_reader` cannot use shell, files, web, browser, Docker, or automations.
- [ ] An authenticated Zach email creates exactly one Workboard card.
- [ ] A spoofed or malicious email fails the intake tests.
- [ ] Ichabod can send Zach email without a routine approval.
- [ ] Scheduled work survives Gateway and host restart.

Deployment:

- [ ] Traefik returns after reboot and owns only public ports 80/443.
- [ ] Two hostnames route to two different Compose services.
- [ ] A new labeled application receives valid HTTPS without a DNS edit.
- [ ] Containers have health, resource, restart, PID, and log limits.
- [ ] Useful source is committed and pushed privately.
- [ ] One request travels from email to tested public site without Zach opening a session.

Recovery:

- [ ] An OpenClaw backup verifies and exists off-host.
- [ ] At least one application backup has been restored successfully.
- [ ] A current EBS snapshot exists.
- [ ] Zach can disable ingestion, stop the Gateway, stop an app, revoke credentials, and stop EC2.

The human acceptance test is simple:

> Email Ichabod a small website idea. Later receive a working HTTPS link, a short explanation, source history, test evidence, and no hidden infrastructure surprise.

