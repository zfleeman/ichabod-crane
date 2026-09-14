# Ichabod guide

How the box is built and why: the machine, the accounts, the host, the web layer, and how to run it day to day. The agent runtime on top of it — Pi, cron, the board and the mail membrane — is [RUNTIME.md](RUNTIME.md) and [MEMBRANE.md](MEMBRANE.md). Nothing in this document depends on which harness drives the model.

This is a personal autonomous lab, not a production platform. The agent gets root-equivalent Docker access because that freedom is part of the experiment, and the matching rule is simple: nothing on the machine should be irreplaceable or dangerous to lose.

There is no deployment broker — no Coolify, Kubernetes, GitHub Actions or image registry — and none is planned. Needing another platform layer is a signal to shrink the experiment, not to grow the platform.

# 1. Authority and risk

The autonomy boundary is the machine and the dedicated accounts attached to it.

## Preauthorized

Ichabod may, without asking: create and delete files under its work and application directories; install dependencies and research on the web; create repositories, branches, commits, issues and releases on its own GitHub account; build, run, replace and remove Docker containers; publish applications under `*.ichabod-crane.net`; create its own cards and scheduled passes; email Zach; and choose and finish self-directed work within its resource budget.

## Kept outside the box

Ichabod does not receive Zach's personal email, GitHub, ChatGPT or any other personal credentials; AWS administrator credentials or permission to run OpenTofu; a broad instance role; access to other networks or machines; or payment cards and authority to enter contracts.

It also may not **widen its own trust boundary** — the sender allowlist, the membrane, or anything else that changes who may instruct it. Everything else it is trusted with affects what it *does*; those change who may *tell it what to do*. An agent that can extend its own boundary has none, and the failure does not need to be malicious: a plausible email asking to add a collaborator is enough. Ichabod may draft such a change and explain it. Zach applies it.

## The honest Docker risk

Membership in the `docker` group is effectively host root: a container can mount the host filesystem and replace host files ([Docker says so](https://docs.docker.com/engine/install/linux-postinstall/)). That is accepted. The compensating controls are operational — only bot-owned credentials on the box, source and backups recoverable off it, alarms on cost and health, one heavy builder at a time, and a rehearsed way to stop it. The objective is not to protect the box from Ichabod. It is to keep an Ichabod failure inside the box.

## Guest senders (deferred)

Version 1 has one allowed sender: Zach. Sender verification answers "is this who it claims to be", not "what may this person cause". Adding a friend's address without a second mechanism hands them the same root-equivalent agent. If guests ever arrive, authority has to be carried on the card by the membrane (a `guest` label it can set and a `zach` one it cannot), and whatever dispatches work must refuse a `guest` card mechanically rather than by remembering to. Add guests one at a time, and only for a specific reason.

# 2. Machine and cost

**Decided: `t3a.large`** — 2 vCPU, 8 GiB — with a 100 GiB gp3 root volume, around $67 a month. Eight GiB is for compilers, Docker layers, headless Chromium and a little concurrency, not the tiny sites. `t3a.medium` runs out of memory on builds; `t3a.xlarge` is only worth it after measuring real contention.

CPU credits are `standard`, so a long build slows down instead of producing a surplus-credit bill. A gp3 volume gets the same baseline IOPS at any size and can be grown while running, so 100 GiB is a reversible choice. Docker is what fills it.

Resize only on evidence: memory repeatedly above 85%, swap during ordinary work, builds blocked on CPU credits, or a genuine need for two simultaneous heavy workers. Reduce concurrency and prune first.

# 3. Accounts, domain, and email

| Account | Purpose |
|---|---|
| AWS | EC2, Elastic IP, DNS, budgets. Zach's, never on the box |
| GitHub | `ich4bod`, the bot account Ichabod pushes to |
| Email | `ichabod@ichabod-crane.net` on Fastmail |
| Model provider | ChatGPT Plus on `ichabod@ichabod-crane.net`, logged in with Pi. Ichabod's own account, not Zach's |

Account passwords and recovery codes never go on the instance; only the tokens listed under Secrets below do.

**GitHub.** The SSH key is generated on the box so the private half never travels, and it is an account-level key on the bot account, because Ichabod creates repositories itself and a deploy key would need adding to each. `gh` is authenticated separately with a fine-grained token scoped to the bot account, set as `GH_TOKEN`, which `gh` reads from the environment.

**Domain.** Route 53 is authoritative for `ichabod-crane.net`, web and mail records both. An apex and a wildcard A record point at the Elastic IP; the wildcard does not answer for the apex, so both exist. The board's `ichabod-board.zfleeman.com` record is in `tofu/` too, and points at Zach's Synology rather than the box.

**Email.** A paid mailbox with a custom domain, real IMAP, real SMTP and app passwords. Fastmail Standard is the floor there, since Basic has no third-party IMAP. App passwords rather than OAuth: scoped to mail, revocable on their own, and they do not expire mid-week. There are two, one for `receive-mail` and one for `send-mail`, so sending can be revoked without breaking receive-mail. DKIM is the provider's job — mail leaves through its SMTP and is signed on the way out, so nothing on the box holds a signing key. Do not self-host mail to save a few dollars; deliverability is a separate project.

**Secrets.** Not AWS Secrets Manager. A root-equivalent agent with a role that can fetch a secret can fetch it anyway, so it would improve rotation, not isolation. Secrets live in one file, `/home/ichabod/.config/ichabod/env`, mode 0600, and [`env.example`](../home/.config/ichabod/env.example) lists every name it needs.

Set each one from the laptop, after the first `make deploy`:

```bash
make secret NAME=KANBOARD_TOKEN
```

That opens an SSM session straight into [`set-secret`](../home/bin/set-secret) as `ichabod`, which asks for the value with echo off and rewrites that one line of the file. The value is typed, never passed as an argument, so it stays out of shell history, `ps`, and SSM's command history, where parameters are kept. Run it again to replace a value. Avoid opening the file in an editor over `make shell`: the editor shows the values on screen, which Session Manager logging records, and vim leaves swap files behind.

The ChatGPT login is the one secret not in that file. Log in once with `make shell`, then `sudo -iu ichabod`, run `pi`, type `/login`, and choose ChatGPT Plus/Pro (Codex) with the device code option. Pi keeps the token in `/home/ichabod/.pi/agent/auth.json` and refreshes it itself.

# 4. Infrastructure

`tofu/` is the whole AWS footprint. Zach applies it from his laptop; Ichabod never does. The comments in `main.tf` carry the reasoning per resource, and these are the choices that shape it:

- **The default VPC.** It already has a public subnet, an Internet gateway and a route. The parts of AWS networking that cost money — NAT gateways, VPC endpoints — are exactly the parts a box that needs outbound Internet and inbound 80/443 does not need.
- **No port 22, ever.** Administration is SSM, which rides the instance's outbound connection, so access is an IAM question rather than a firewall one and works from any network.
- **One IAM role, and it is safe to hold.** `AmazonSSMManagedInstanceCore` lets the instance be managed by SSM and grants nothing else in the account. `CloudWatchAgentServerPolicy` sits beside it so the host can publish memory and disk. Nothing else goes on it.
- **Instance metadata needs a token and stops at one hop.** IMDSv2 with a hop limit of 1 means a container on Docker's bridge network cannot reach the metadata service or the role's credentials.
- **The AMI is pinned by hand.** A `most_recent` lookup would silently replace the instance on a later apply.

Gotchas that look like failures and are not:

- `disable_api_termination = true` makes `tofu destroy` fail. Set it false and apply once before an intentional teardown.
- The SNS email subscription stays pending until the confirmation link is clicked, and alarms are silent until then.
- The three `CWAgent` alarms sit in `INSUFFICIENT_DATA` until the CloudWatch agent is installed on the host.
- A fresh host trips `ichabod-cpu-credit-balance-low` during setup, because patching and installing Docker spend the launch credits. It clears on its own once the box idles.

# 5. Host

Everything below runs from `make shell`, which lands as `ssm-user` with passwordless sudo. There is no `ubuntu` user in this workflow; that is Canonical's SSH login and is vestigial here. The account that matters is `ichabod`, which owns everything the agent does.

1. `apt-get update && apt-get upgrade -y`, install `ca-certificates curl git jq unzip build-essential python3-dkim python3-dnspython`, reboot.
2. `useradd --create-home --shell /bin/bash ichabod`. Name the shell: `useradd` defaults to `/bin/sh`, which is dash on Ubuntu, and a dash login shell never reads `~/.bashrc`, so installer `PATH` lines silently never load.
3. Create `apps`, `platform`, `backups` and `src` under `/home/ichabod`, owned by `ichabod`.
4. A 4 GiB swap file in `/etc/fstab`. It is an OOM fuse, not working memory.
5. `systemctl disable --now ssh ssh.socket`. Both units: on 24.04 sshd is socket-activated, so disabling only the service leaves port 22 listening. `ss -lntp` showing nothing on 22 is the check that settles it.
6. Install the CloudWatch agent. Its config lives at `/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json`, collects only `/`, and sets `aggregation_dimensions` to `InstanceId`. Both details are load-bearing: the alarms have `InstanceId` as their only dimension, and the default per-filesystem metrics also carry `path`, `device` and `fstype`, which never match. Also install the [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), which `health` uses to publish heartbeats with the instance role.
7. Install Docker Engine, `usermod -aG docker ichabod`, and cap logs in `/etc/docker/daemon.json` before any application exists:

   ```json
   { "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
   ```

   `docker run --rm hello-world` as `ichabod` is not a formality; it confirms the intended root-equivalent authority. `ssm-user` reaches Docker only through sudo and should stay that way.
8. Install the GitHub CLI from [GitHub's apt repository](https://github.com/cli/cli/blob/trunk/docs/install_linux.md); Ubuntu's own package lags well behind.
9. Install Node and Pi system-wide, as root. Node comes from [NodeSource's apt repository](https://github.com/nodesource/distributions), because Ubuntu's own package is older than Pi supports:

   ```
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
   sudo apt-get install -y --allow-change-held-packages nodejs=24.21.0-1nodesource1
   sudo apt-mark hold nodejs
   sudo npm install -g @earendil-works/pi-coding-agent@0.85.1
   ```

   This puts `node` and `pi` in `/usr/bin`, owned by root. `receive-mail` starts the membrane with `PATH=/usr/bin` and nothing else, so a `pi` installed anywhere else makes every email fail. Root ownership also means Ichabod cannot swap the `pi` the membrane runs. Check all three: `env -i PATH=/usr/bin pi --version` prints a version, `sudo -u ichabod bash -lc 'command -v pi'` prints `/usr/bin/pi`, and `ls -l /usr/bin/pi` shows root. To upgrade, change both pins here and rerun these lines.
10. As `ichabod`, generate an SSH key with `ssh-keygen -t ed25519` and add the public half to `ich4bod` as an account key. Set `git config --global user.name` and `user.email` to Ichabod's.

Then, from the laptop, `make deploy` and `make secret` for each name in [`env.example`](../home/.config/ichabod/env.example). [RUNTIME.md](RUNTIME.md) covers everything after that.

## Where things live

| Path | Contents | Backed up by |
|---|---|---|
| `/home/ichabod/apps/<slug>/` | One directory per application: source, Dockerfile, `compose.yaml`, its own `.git` | GitHub for source, the app's own backup for data |
| `/home/ichabod/platform/` | Traefik and other host-owned compose projects | This repo, under `home/platform/` |
| `/home/ichabod/backups/` | Staging before a backup leaves the box | Copied off-host |
| `/home/ichabod/src/` | Ichabod's checkouts of repositories he proposes changes to, such as his fork of `ichabod-crane` | GitHub |
| `/var/lib/docker/` | Images, layers, build cache, named volumes | Volume by volume, never wholesale |

The runtime's own directories are laid out in [RUNTIME.md](RUNTIME.md#layout). `/var/lib/docker` is what fills the disk; `docker system df` is the thing to watch.

# 6. Administration

Every command Zach runs by hand is a `make` target, so connection details live in version control. `make help` lists them. The SSM targets read the instance ID from tofu state rather than hardcoding it, and every target runs as the `ZACH-ROOT` AWS profile, exported so `tofu` reads it too. The laptop needs `brew install --cask session-manager-plugin` once.

`make status` asks two services one question, because either can be the problem: EC2 knows whether the machine is on, SSM knows whether it is reachable. `running / not answering` is the case worth spotting. `make start` waits for SSM, not just for EC2 to say `running`, because everything else needs SSM.

Session Manager can log every session to S3 or CloudWatch Logs, which is worth enabling so administrative access to a root-equivalent box is auditable.

# 7. Web: Traefik and applications

Traefik is the only deployment control plane. It owns 80 and 443, watches the Docker socket, and builds its routing table from container labels. The labels in an app's `compose.yaml` *are* the configuration — there is no Traefik file listing sites and nothing to reload. So a new site is one compose file and one `docker compose up`: no Route 53 edit, no security-group change, no proxy edit.

## Traefik, once

[`home/platform/traefik/compose.yaml`](../home/platform/traefik/compose.yaml) is the whole configuration, pinned to one Traefik version. `make deploy` installs it at `/home/ichabod/platform/traefik/compose.yaml`, read-only to `ichabod` like every shipped file, so a change to it is a pull request. Start it once after the first deploy, as `ichabod`:

```bash
cd /home/ichabod/platform/traefik && docker compose up -d
```

It creates the `ichabod-proxy` network that every application joins, so it has to be up before the first application.

Three things that cost time:

- **A healthy Traefik logs nothing.** `--log.level` defaults to `ERROR`, so an empty log is the pass, not a dead container. ACME failures are errors and do appear.
- **The first request to a new hostname fails** with `unable to get local issuer certificate`. That is Traefik's built-in self-signed certificate answering while issuance runs. Wait half a minute before investigating.
- **The ACME account is pinned on first issuance.** Changing the email later changes the flag but not the registered account; it means deleting `acme.json` and re-issuing. Port 80 stays open to the world because HTTP-01 challenges arrive there.

Back up the `ichabod-proxy_letsencrypt` volume or expect to re-issue after a rebuild. Traefik is trusted control-plane code with the Docker socket, so pin it, update it deliberately, and never let an application share its compose project.

## The application contract

[`home/templates/app/compose.yaml`](../home/templates/app/compose.yaml) is the starting point and already carries the shape. An application builds reproducibly from its repository, listens on `0.0.0.0` inside the container, publishes no host port, joins the external `ichabod-proxy` network, sets an explicit `Host()` rule, has a health check it can actually fail, and sets restart, CPU, memory, PID and log limits. The template's CPU and memory defaults are a blast radius, not a budget, and are raised from a measured peak, never an estimate. Those limits are the only capacity ceiling on the box that Docker enforces rather than the agent remembering.

The deploy sequence:

```bash
cd /home/ichabod/apps/<slug>
docker compose config
docker compose build
docker compose run --rm <tests>
git add . && git commit -m "..." && git push
docker compose up -d --build
docker compose ps
curl --fail https://<slug>.ichabod-crane.net/healthz
```

Push source before or immediately after deploying; GitHub is the durable history and the local image is replaceable. Every stateful application's README names its volume, backup command, restore command, retention, and last tested restore date — an EBS snapshot captures bytes, not a consistent database, and GitHub never has the data.

Housekeeping: roughly five running experiments at most, one active heavy build, prune build cache and unreferenced images only after looking at them, and never automate `docker volume prune`.

# 8. Operations

## Touchpoints

| When | What |
|---|---|
| Whenever | Email Ichabod |
| Weekly | Finished and blocked work, self-directed work, disk (`docker system df`), running services |
| Monthly | AWS cost, ChatGPT usage against its limits, updates, backups, stale applications |
| Rarely | `make shell` for upgrades, credentials, recovery, or resizing |

The acceptance test for the whole system is one sentence: email Ichabod a small website idea, and later receive a working HTTPS link, a short explanation, source history and test evidence, with no infrastructure surprise and no session opened.

## Backups

1. **GitHub** — source for every valuable project.
2. **Application-native** — dumps or volume archives, per the app's README.
3. **EBS snapshots** — whole-machine recovery, on a lifecycle policy owned by Zach's AWS account and never touched from the box.

The workspace (`MEMORY.md`, `memory/`, `own-skills/`) has no backup of its own and lives only on the box and its snapshots. Kanboard's data lives on the Synology, off the box.

A backup stored only on the failed volume is not a recovery plan, and an untested restore is a hypothesis. Restore one into a disposable instance at least once.

## Updates

One layer at a time, with a current backup, the old version recorded and the release notes read. Afterwards recheck Docker, Traefik, the agent's passes, and one public site. Pin Traefik and base images. Ichabod may update its own projects' dependencies; Docker, Traefik, the SSM agent and Pi are workshop machinery that Zach updates deliberately.

## Kill switches

Least to most severe:

1. Stop the schedule: `sudo rm /etc/cron.d/ichabod-schedule`, and `sudo crontab -u ichabod -r` for any passes Ichabod scheduled himself. `make deploy` never reinstalls it; only `make cron` does.
2. Revoke the mailbox app passwords, the GitHub token and the `ichabod` Kanboard user's token, and sign the box out of ChatGPT.
3. `docker compose down` in one application's directory.
4. `make stop`.
5. If compromise is suspected: remove public ingress, revoke credentials, snapshot the disk, and investigate a copy.

Stopping EC2 does not stop EBS, Elastic IP, domain or snapshot charges.

## Troubleshooting

| Symptom | First checks |
|---|---|
| `make shell` fails | Instance state, SSM ping status, instance profile, local AWS credentials, session-manager-plugin |
| Hostname does not resolve | Registrar nameservers, apex and wildcard records, Elastic IP |
| HTTPS fails | Ports 80/443, Traefik logs, router labels, ACME storage, DNS — and wait 30 seconds first |
| Wrong app answers | Duplicate router name or `Host()` label, stale container |
| Container unhealthy | Bind address, internal port, health command, logs, OOM |
| Host is slow | `free -h`, swap, CPU credit balance, concurrent builds, container limits |
| Disk fills | `docker system df`, logs, build cache, old images. Preserve volumes |
| A pass did not run | `/etc/cron.d/ichabod-schedule` exists, today's `log/` directory, a lock left in `.local/state/`, `log/usage.jsonl` for a hit limit |
| An email made no card | Sender allowlist, DMARC result, the quarantine folder |

# 9. References

- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [post-install security](https://docs.docker.com/engine/install/linux-postinstall/), [Compose reference](https://docs.docker.com/reference/compose-file/)
- [Traefik Docker provider](https://doc.traefik.io/traefik/providers/docker/), [Traefik ACME](https://doc.traefik.io/traefik/https/acme/)
- [OpenTofu](https://opentofu.org/docs/), [AWS provider](https://registry.terraform.io/providers/hashicorp/aws/latest/docs), [Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
- [Fastmail server names and ports](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports), [Route 53 developer guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/Welcome.html)
