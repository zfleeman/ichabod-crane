# RFC-01 — Foundations: scope, authority, and accounts

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Scope** | What the machine is, what Ichabod is allowed to do, what it costs, and the dedicated accounts, domain, mailbox, and secret storage it needs. |
| **Related** | [RFC-02](RFC-02-infrastructure.md), [RFC-03](RFC-03-host-and-deployment.md), [RFC-04](RFC-04-agent-runtime.md), [RFC-05](RFC-05-autonomy-and-operations.md) |

## The machine

The recommended first version is intentionally small:

| Layer | Choice |
|---|---|
| Host | One dedicated Ubuntu 24.04 x86-64 machine |
| Cloud size | EC2 `t3a.large`: 2 vCPU, 8 GiB RAM |
| Storage | 100 GiB encrypted gp3 |
| Orchestrator | OpenClaw installed natively as user `openclaw` |
| Model | Claude Code logged into a dedicated Claude subscription |
| Work queue | OpenClaw Workboard |
| Build and deployment | Direct Docker Engine and Docker Compose on the host |
| Public routing | Standalone Traefik watching Docker labels |
| Source control | Dedicated private GitHub account or organization |
| Communication | Email through OpenClaw IMAP plus a separate SMTP sender |
| Secrets | OpenClaw SecretRefs and shared secret store |
| Administration | Loopback-only Gateway reached through an AWS SSM port forward; no SSH, no open port 22 |

The working flow is:

```text
Zach's email
    ↓
restricted mail reader verifies the sender
    ↓
Workboard triage card
    ↓
Ichabod chooses, decomposes, and executes work
    ├── source and tests
    ├── private Git commits
    ├── temporary or durable agents
    └── recurring automations
            ↓
docker compose up -d --build
            ↓
Traefik reads the app's labels
            ↓
https://app-name.ichabod-crane.net
            ↓
Workboard proof + email to Zach
```

**What is actually named Ichabod?** The OpenClaw agent whose id is `main`. Everything else — the EC2 instance, the domain, `/srv/ichabod` — just borrows the name. The personality lives in `main`'s workspace files: `IDENTITY.md` sets the name and presentation, `SOUL.md` sets voice and temperament, and `agents.entries.main.identity` in `openclaw.json` sets the display name and emoji. See [RFC-04](RFC-04-agent-runtime.md#identity-agents-and-workboard).

There is no deployment broker. There is no Coolify, Kubernetes, GitHub Actions, or image registry, and none is planned. This box stays an experiment; needing another platform layer is a signal to shrink the experiment, not to grow the platform.

### How a new site becomes reachable

Create these DNS records once:

```text
ichabod-crane.net       A    <Elastic IP>
*.ichabod-crane.net     A    <Elastic IP>
```

The wildcard sends every first-level hostname to the same machine. Traefik examines the HTTP `Host` header and routes the request using labels in each application's Compose file. Therefore a new site normally requires:

1. A Docker image built locally.
2. A Compose service connected to the shared proxy network.
3. A label naming `something.ichabod-crane.net`.
4. `docker compose up -d --build`.

No Route 53 edit, security-group edit, or proxy configuration edit is needed per application. Traefik requests and renews an individual TLS certificate for each hostname.

### What OpenClaw contributes

OpenClaw is the persistent operating layer:

- The Gateway owns sessions, channels, credentials, automations, and state.
- Workboard stores tasks, attempts, proof, dependencies, and assignments.
- Agent workspaces store identity, policy, memory, and durable files.
- Fresh agent runs can continue work after an earlier context fills.
- The `full` permission mode lets the main agent execute on the host and make supported persistent changes without routine approval.

### How memory is actually stored

Markdown files are the native pattern, not a workaround. OpenClaw loads `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, and a curated `MEMORY.md` (capped around 4,000 characters) into the prompt, and keeps detailed daily logs in `memory/YYYY-MM-DD.md` that memory tools retrieve on demand instead of injecting every turn. There is no database-backed workspace memory to switch to. [Agent workspaces](https://docs.openclaw.ai/agent-workspace)

The durable part is already a database: sessions, Workboard cards, automations, and secrets live in SQLite under `~/.openclaw/`. So the split is markdown for what the model reads, SQLite for what the Gateway tracks. Keep it — the alternative is bolting on tooling OpenClaw would not use. When a *project* needs structured recall (the GPU-deal history, for example), give that project its own Postgres container; do not try to relocate agent memory.

OpenClaw does not itself make Docker safe, deploy a site automatically, or turn a Claude subscription into unlimited usage. This design intentionally gives its main service account the host permissions needed to do those things directly.

## Authority and risk

The autonomy boundary is the entire Ichabod machine and the dedicated accounts attached to it.

### Preauthorized

Ichabod may do the following without asking:

- Create, edit, test, and delete files under its work and application directories.
- Install project dependencies and research on the web.
- Create private repositories, branches, commits, issues, and releases in its GitHub identity.
- Build, start, stop, replace, and inspect Docker containers.
- Publish applications beneath `*.ichabod-crane.net`.
- Create temporary workers and durable OpenClaw agents.
- Create and modify ordinary OpenClaw automations and Workboard cards.
- Send routine email to Zach and reply to an allowlisted requester.
- Choose and finish self-directed work within its resource budget.
- Repair its own projects and improve its templates, tools, and instructions.

The main agent — agent id `main`, the one named Ichabod — runs with host execution and no routine command reviewer. `full` is a real OpenClaw permission mode, the most permissive of `read-only`, `guarded`, `workspace`, and `full`. It is chosen per session from the Permissions menu (or inherited from the configured `tools.exec.mode` default) and requires `operator.admin`. A `full` session can apply supported durable-agent operations without an operator prompt. This is broad authority, not a narrow “agent creation only” exception. See [OpenClaw permission modes](https://docs.openclaw.ai/gateway/permission-modes).

### Kept outside the box

Ichabod should not receive:

- Zach's personal email, GitHub, Claude, or password-manager credentials.
- AWS administrator credentials.
- Permission to run OpenTofu against its own account.
- A broad EC2 instance role.
- Access to unrelated networks or machines.
- Payment cards or authority to enter contracts.
- Authority to edit its own `allowedSenders`, permission mode, or exec policy — anything that widens who may instruct it or what it may do without asking.

The main agent may create websites and send messages, but `AGENTS.md` should still say that it cannot impersonate Zach, purchase things, agree to legal terms, or conceal who is speaking.

### The honest Docker risk

Membership in the `docker` group is effectively host root. A container can mount the host filesystem, inspect processes, and replace host files. [Docker documents this privilege explicitly](https://docs.docker.com/engine/install/linux-postinstall/).

That is accepted here. The compensating controls are operational:

- Use a dedicated AWS account if practical.
- Keep only bot-owned credentials on the machine.
- Make repositories and backups recoverable off-host.
- Watch cost and host health with alarms (below).
- Limit initial concurrency to one builder.
- Keep a documented stop/revoke procedure.

The objective is not to protect the box from Ichabod. It is to keep an Ichabod failure inside the box and its dedicated accounts.

### Alarms

Three layers, cheapest first:

| Layer | Tool | Watches |
|---|---|---|
| Cost | AWS Budgets, monthly actual + forecast, SNS to Zach's real email | Runaway spend |
| Host | CloudWatch alarms on EC2 metrics | `StatusCheckFailed`, `CPUCreditBalance`, `EBSByteBalance` |
| Inside the box | CloudWatch agent publishing `mem_used_percent` and `disk_used_percent` | Memory pressure and the disk filling with Docker layers |

Memory and disk are not EC2-native metrics, so the CloudWatch agent (or an equivalent) is required to alarm on them. That is the one piece worth installing during host setup.

Alternatives worth knowing: a free dead-man's-switch ping (Healthchecks.io, Better Stack) that alerts when the box *stops* checking in — CloudWatch cannot alarm on an instance that is simply gone from the network in the way a missed heartbeat can; and Ichabod's own operations pass, which already inspects `df -h`, `free -h`, and `docker system df` and can email Zach. Use CloudWatch for the money and the hardware, the dead-man's switch for total silence, and Ichabod for everything it can see from inside.

### Email remains an untrusted input

Even an authentic email can quote a malicious web page or contain prompt-injection text. The bundled IMAP plugin should dispatch admitted messages to a restricted `mail_reader` agent. That agent has no shell, filesystem, browser, web, Docker, scheduler, or Gateway authority. Its only useful mutation is creating a Workboard triage card.

This is automatic filtering, not a human approval gate:

```text
authenticated Zach email
  → restricted summary
  → triage card
  → `full`-mode main agent
```

Version 1 has exactly one allowlisted sender: Zach. There is no guest lane yet, because building one means a second IMAP account definition, a second restricted reader agent, and card metadata that survives the handoff. The full shape is in [RFC-04](RFC-04-agent-runtime.md#guest-senders-deferred).

**Can Ichabod build that lane itself later?** Technically yes — it runs in `full` mode and can edit `openclaw.json`. It should not, and this belongs on the list of things kept outside the box. Everything else Ichabod is trusted with affects what it *does*; changing `allowedSenders` changes who is allowed to *instruct* it. An agent that can extend its own trust boundary has no boundary, and the failure does not need to be malicious — a plausible-sounding email asking to add a collaborator is enough.

So Ichabod may draft the config, explain the tradeoff, and open a card. Zach applies it. Until then, do not treat “known email address” as equivalent to “may use the root-equivalent main agent.”

### What 24/7 means

Do not try to keep one conversation alive forever. Persistent autonomy comes from:

- Workboard for queue state.
- Git and application databases for artifacts.
- Memory files for durable context (see [how memory is stored](#how-memory-is-actually-stored)).
- Automations for recurring wakeups.
- systemd for Gateway restart after logout or reboot.

## Where to run it and what it costs

### EC2 sizing

**Decided: `t3a.large`** — 2 vCPU, 8 GiB — with 100 GiB gp3 and one active build/browser job at a time. Roughly $67 per month all in.

The neighbours, for context when resizing later:

| Size | Resources | Approximate monthly infrastructure | Judgment |
|---|---:|---:|---|
| `t3a.medium` | 2 vCPU / 4 GiB | $38 | Docker builds or Chromium run out of memory |
| `t3a.large` | 2 vCPU / 8 GiB | $67 | **The choice** |
| `t3a.xlarge` | 4 vCPU / 16 GiB | $126 | Only after observing real contention |

The estimates include on-demand compute, representative gp3 storage, one public IPv4 address, and a DNS zone. They exclude domain registration, Claude, email, data transfer, and backups. Check the [current EC2 price map](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20West%20(Oregon)/Linux/index.json), [EBS pricing](https://aws.amazon.com/ebs/general-purpose/), and [public IPv4 pricing](https://aws.amazon.com/vpc/pricing/) before applying.

T3 instances are burstable. Configure CPU credits as `standard` for a predictable ceiling and watch `CPUCreditBalance`. A long build may slow down after consuming credits; that is preferable to surprise surplus-credit charges during the pilot. [AWS T3 documentation](https://aws.amazon.com/ec2/instance-types/t3/)

Eight GiB is not for the tiny websites. It is for compilers, package managers, Docker layers, Chromium, tests, OpenClaw, Traefik, and a little concurrency. No GPU is required because model inference happens remotely.

**Is 100 GiB small?** It is modest but not tight — about $8 per month, and roughly three times what a bare Ubuntu install plus OpenClaw uses. Docker is what consumes it: images, build cache, and container logs, which is why log rotation and weekly `docker system df` appear in [RFC-03](RFC-03-host-and-deployment.md#disk-housekeeping). Size does not affect speed here, because a gp3 volume gets the same 3,000 IOPS and 125 MB/s baseline at any size; you pay for more capacity, not more throughput. A gp3 volume can also be grown while the instance is running, so starting at 100 GiB is a reversible decision.

### Local alternatives

The 2014 MacBook Air is not a candidate: two cores, at most 8 GiB (usually 4), a 128–256 GiB SSD, and no supported macOS. Docker builds and a headless Chromium would thrash it, and a home connection adds port forwarding, dynamic DNS, and outage handling on top. Use it as a client for the box, not as the box.

If a spare 16 GiB x86 desktop or an N100/Ryzen mini PC ever appears, local hardware is the cheaper pilot. Otherwise this is a cloud build, and the rest of this design assumes EC2.

### When to resize

Resize only after measuring:

- Memory repeatedly above 85% or regular OOM kills.
- Swap activity during ordinary work.
- Build queues that remain blocked by CPU credits.
- A genuine need for two simultaneous browser/build workers.

First reduce concurrency and prune stale Docker data. Then move to 4 vCPU / 16 GiB if the work is genuinely blocked without it. This is R&D; it is not expected to pay for itself, so the question is whether the extra $59 per month buys experiments worth running, not whether it earns a return.

## Accounts, domain, email, and secrets

Create dedicated identities before provisioning:

| Account | Purpose | Keep separate from |
|---|---|---|
| AWS | EC2, Elastic IP, DNS, budgets, backups | Other personal or work infrastructure |
| Claude | Claude Code subscription for Ichabod | Zach's normal Claude history and quota |
| GitHub | Private repositories created by Ichabod | Zach's personal repositories |
| Email | `ichabod@ichabod-crane.net` | Zach's primary mailbox |

Use strong unique passwords and retain recovery codes in Zach's password manager, not on the EC2 instance.

### Claude subscription

Log Claude Code in interactively as the Linux `openclaw` user. **No API key, ever.** Never set `ANTHROPIC_API_KEY` on this host and never accept an onboarding prompt that offers a metered fallback, because a fallback is exactly how a runaway loop turns into a bill.

A subscription is a fixed cost with a usage allowance, not an unlimited pool, so the honest answer is that Ichabod will hit limits and stop. A Max plan buys a lot of room, but a busy autonomous day can still exhaust a session or weekly window. That is fine, and it is why every card carries a checkpoint: when the allowance runs out Ichabod records status, next action, and commit, and the director automation picks the card back up once the window resets. Design for pauses instead of paying to avoid them.

### GitHub

Use a bot-owned account or organization and private repositories by default. The first version needs only source control:

- Ichabod writes and tests locally.
- It commits and pushes useful work.
- The running image is built on the same host.

GitHub Actions and GHCR can be added if a second host, immutable registry artifacts, or off-host builds later become valuable.

#### Giving Ichabod push access

Generate the key on the box, as the `openclaw` user, so the private half never travels:

```bash
sudo -iu openclaw
ssh-keygen -t ed25519 -C "ichabod@ichabod-crane.net" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Paste that public key into the **bot** account under Settings → SSH and GPG keys → New SSH key. Use an account-level key rather than per-repository deploy keys, because Ichabod creates repositories on its own and a deploy key would have to be added to each one. Then verify and set the commit identity:

```bash
ssh -T git@github.com
git config --global user.name "Ichabod"
git config --global user.email "ichabod@ichabod-crane.net"
```

This key is for `git push` only. Creating repositories and issues needs the API, so also run `gh auth login` as `openclaw` with a fine-grained token scoped to the bot account, and store that token as a SecretRef rather than leaving it in a shell history. Zach's personal GitHub keys never touch this machine.

### Domain and wildcard DNS

Register `ichabod-crane.net` through Route 53 Registrar or another registrar. Registration and authoritative DNS are separate choices; **Route 53 is the authoritative DNS for this build**, so point the registrar's nameservers at the Route 53 hosted zone and keep every record — web and mail — in that one zone. OpenTofu creates the apex and wildcard A records.

The records required for public applications are:

```text
@    A    <Elastic IP>
*    A    <Elastic IP>
```

Mail adds MX, SPF, DKIM, and DMARC records. Those coexist with the web records.

### Email

Use a paid mailbox with a custom domain and third-party IMAP/SMTP access. Free forwarding designs exist, but they trade a few dollars a month for a forwarder plus a second mailbox plus send-only restrictions, and Ichabod needs to both read and send reliably. The mailbox is the front door of the whole system; pay for it.

The requirement is narrow: custom domain, real IMAP, real SMTP, and an app password a machine can use.

| Provider | Approximate cost | Notes |
|---|---|---|
| Fastmail (Individual/Standard) | ~$6/month | Well-documented app passwords and server settings. Basic tier does **not** allow third-party IMAP, so Standard is the floor |
| Migadu (Micro) | ~$19/year | Cheapest credible option; priced per message volume rather than per mailbox |
| mailbox.org | ~€3/month | Privacy-oriented, standard IMAP/SMTP |
| Zoho Mail (Mail Lite) | ~$1/user/month | Cheapest monthly; IMAP requires enabling and an app password |
| Purelymail | ~$10/year | Very cheap, small operator; fine for a lab, thin support |

Fastmail is the safe default and Migadu the cheap one. See [Fastmail plans](https://www.fastmail.help/hc/en-us/articles/8033939068815-2024-pricing-and-plan-updates) and [server settings](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports).

Setup, with any provider:

1. Add `ichabod-crane.net` in the provider's domain screen.
2. Copy its MX, SPF, DKIM, and DMARC records into the Route 53 hosted zone. They coexist with the apex and wildcard A records.
3. Create `ichabod@ichabod-crane.net`.
4. Create a dedicated app password for IMAP/SMTP.
5. Send mail in both directions and inspect authentication results before connecting OpenClaw.

Do not self-host mail on Ichabod merely to save a few dollars. Deliverability and reputation management are a separate project.

### OpenClaw SecretRefs

Do not use AWS Secrets Manager initially. A root-equivalent agent with an instance role capable of retrieving a secret can retrieve it anyway. Secrets Manager would improve rotation mechanics, not isolate the secret from Ichabod.

Use OpenClaw's shared secret store and SecretRefs:

```json5
{
  source: "store",
  provider: "default",
  id: "IMAP_PASSWORD"
}
```

Create protected entries through **Settings → Secrets** in the Control UI or with `openclaw secrets store`. Protected values are write-only through normal UI and RPC surfaces. After local CLI changes, reload the active snapshot:

```bash
openclaw secrets reload
openclaw secrets audit --check
```

Migrate every supported plaintext credential until the audit is clean. Never paste secrets into these documents, Git, OpenTofu variables, cloud-init, Workboard cards, email, or agent prompts.

OpenClaw's store is not an HSM: values are stored in its local SQLite state and protected by filesystem permissions. SecretRefs reduce casual exposure in configuration, generated files, logs, and model context; they do not protect secrets from a root-equivalent host process. [OpenClaw secrets management](https://docs.openclaw.ai/gateway/secrets)

SQLite here is not a weak choice you can upgrade — it is where OpenClaw keeps its own state, it is not swappable, and single-writer embedded SQLite is genuinely solid for one process on one box. The risk is the disk, not the engine, so the mitigation is backups: `openclaw backup create --verify` copied off-host, plus EBS snapshots ([RFC-05](RFC-05-autonomy-and-operations.md#operations-recovery-and-success-criteria)). Postgres belongs in this design only when an *application* Ichabod builds needs it, as its own container.

Do not attach an EC2 IAM role initially. Add a narrowly scoped role later only for a specific capability you have decided the agent should possess.

