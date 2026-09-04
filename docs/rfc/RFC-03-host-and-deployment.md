# RFC-03 — Host baseline and deployment plane

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Scope** | How the Ubuntu host is provisioned and secured, and how Traefik plus Docker Compose turn a labelled container into a public HTTPS site. |
| **Related** | [RFC-02](RFC-02-infrastructure.md), [RFC-04](RFC-04-agent-runtime.md) |

## Provision and secure the host

Open a shell with SSM (`make shell`, defined in [RFC-02](RFC-02-infrastructure.md#private-administration-with-aws-ssm)). No host key, no private key, no bastion.

SSM drops you in as `ssm-user`, a service-managed account with passwordless sudo — which answers a question the earlier draft left open: **there is no `ubuntu` user in this workflow.** `ubuntu` is just the default login Canonical bakes into its AMIs for SSH, and with SSH gone it is vestigial. The two accounts that matter are `ssm-user` for administration and `openclaw` for everything Ichabod does:

```bash
sudo -iu openclaw     # become Ichabod's service account
```

Every command below that touches OpenClaw, Claude, or Docker assumes you are in that `openclaw` shell.

### Patch and install baseline tools

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git jq unzip build-essential
sudo reboot
```

Reconnect and create the service account and working directories:

```bash
sudo useradd --create-home --shell /bin/bash openclaw
sudo install -d -o openclaw -g openclaw /srv/ichabod
sudo -u openclaw mkdir -p \
  /srv/ichabod/apps \
  /srv/ichabod/platform \
  /srv/ichabod/backups \
  /srv/ichabod/templates
sudo loginctl enable-linger openclaw
```

### Install Docker

Use Docker's current Ubuntu installation instructions. For a disposable lab, its official convenience installer is a reasonable shortcut:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo systemctl enable --now docker
sudo usermod -aG docker openclaw
```

Inspect the downloaded script before executing it if you prefer. Remove it afterward. Re-enter the `openclaw` login session so the new group applies, then verify:

```bash
sudo -iu openclaw
docker version
docker compose version
docker run --rm hello-world
exit
```

This test confirms the intended root-equivalent authority.

Configure Docker log rotation in `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Restart Docker once, before applications exist:

```bash
sudo systemctl restart docker
```

### Swap and basic host policy

If `swapon --show` is empty, create a 4 GiB swap file:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Swap is an OOM fuse, not extra working memory.

There is no sshd configuration to harden, because the security group never admits port 22. If you want the daemon gone entirely rather than merely unreachable:

```bash
sudo systemctl disable --now ssh
```

Leave it installed but disabled; reinstating it from an SSM session is easy, and Git's SSH client is a separate binary that keeps working either way. Confirm the SSM agent is healthy before relying on it as the only door:

```bash
sudo systemctl status amazon-ssm-agent
```

### Disk housekeeping

Docker layers will be the main disk consumer. Begin with:

- An alarm at 75% disk use and urgent alert at 90%.
- One active builder on the 8 GiB instance.
- Weekly inspection with `docker system df`.
- Pruning only unused, reproducible build cache and old images.
- No automatic volume deletion.

### The filesystem map

`/srv` is the Linux convention for "data served by this system" — websites and the services behind them. That is literally what this box does, so application directories belong there rather than in `/opt` (third-party software you installed) or `/home` (a person's own files). Following the convention costs nothing and means the layout is guessable a year from now.

Where everything lives:

| Path | Owner | Contents | Backed up by |
|---|---|---|---|
| `/srv/ichabod/apps/<slug>/` | `openclaw` | One directory per application: source, Dockerfile, compose.yaml, its own `.git` | GitHub (source), volume backups (data) |
| `/srv/ichabod/platform/` | `openclaw` | Traefik and other host-owned infrastructure compose files | Git |
| `/srv/ichabod/templates/` | `openclaw` | Agent workspace template and the `new-agent` script | Git |
| `/srv/ichabod/backups/` | `openclaw` | Local staging for OpenClaw backups before they go off-host | Copied off-host |
| `/home/openclaw/.openclaw/` | `openclaw` | Gateway state, SQLite, secrets, agent workspaces | `openclaw backup create` |
| `/var/lib/docker/` | root | Images, layers, build cache, named volumes | Volume-by-volume, never wholesale |

Two rules that follow from the table. Named Docker volumes hold the only copy of application data, so every stateful app documents its own backup command. And `/var/lib/docker` is what actually fills the disk — it is the thing `docker system df` is watching.

Keep valuable source in GitHub and stateful application data in named volumes with explicit backup instructions.

## Direct Docker deployment with Traefik

Traefik is the only deployment control-plane container. It owns public ports 80 and 443 and watches Docker service labels. Ichabod owns each application's source and Compose file.

### Install Traefik once

Create `/srv/ichabod/platform/traefik/compose.yaml`. Pin a reviewed current Traefik 3.x image instead of leaving an indefinite floating tag:

```yaml
name: ichabod-proxy

services:
  traefik:
    image: traefik:<PINNED_3_X_VERSION>
    restart: unless-stopped
    command:
      - --api.dashboard=false
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.email=<ZACH_EMAIL>
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - letsencrypt:/letsencrypt
    networks:
      - proxy
    security_opt:
      - no-new-privileges:true
    logging:
      options:
        max-size: 10m
        max-file: "3"

networks:
  proxy:
    name: ichabod-proxy

volumes:
  letsencrypt:
```

Then:

```bash
cd /srv/ichabod/platform/traefik
docker compose config
docker compose up -d
docker compose logs --tail=100
```

ACME (Automatic Certificate Management Environment) is the protocol Let's Encrypt uses to issue certificates without a human. The `httpchallenge` lines above select HTTP-01: to prove Ichabod controls `minesweeper.ichabod-crane.net`, Traefik serves a token at `http://minesweeper.ichabod-crane.net/.well-known/acme-challenge/...` and Let's Encrypt fetches it. That is why port 80 stays open to the world even though every real request is redirected to HTTPS, and why certificates are per-hostname rather than one wildcard certificate. Traefik renews them on its own and stores them in the `letsencrypt` volume — back that volume up or expect to re-issue after a rebuild.

The Docker socket is a powerful interface even when mounted read-only. Traefik is trusted control-plane code on a machine where the main agent already has Docker authority. Pin the image, update it deliberately, and do not let generated applications share its Compose project or certificate volume.

### Application contract

Each application lives under:

```text
/srv/ichabod/apps/<slug>/
├── README.md
├── Dockerfile
├── compose.yaml
├── src/...
├── tests/...
└── .git/
```

An application must:

- Build reproducibly from its repository.
- Listen on `0.0.0.0` inside the container.
- Expose a documented internal port.
- Provide a useful health check.
- Publish no host port.
- Join `ichabod-proxy` — a Docker bridge network, created once by the Traefik compose project above and joined by every app as an `external` network. It is the only path between Traefik and an application, which is why apps need no published host ports.
- Set an explicit hostname rule.
- Use restart, CPU, memory, PID, and log limits.
- Document and back up any persistent named volume.

A compact Compose file looks like:

```yaml
name: minesweeper

services:
  web:
    build: .
    restart: unless-stopped
    expose:
      - "3000"
    networks:
      - proxy
    labels:
      - traefik.enable=true
      - "traefik.http.routers.minesweeper.rule=Host(`minesweeper.ichabod-crane.net`)"
      - traefik.http.routers.minesweeper.entrypoints=websecure
      - traefik.http.routers.minesweeper.tls.certresolver=letsencrypt
      - traefik.http.services.minesweeper.loadbalancer.server.port=3000
    cpus: "0.50"
    mem_limit: 512m
    pids_limit: 256
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
    logging:
      options:
        max-size: 10m
        max-file: "3"

networks:
  proxy:
    external: true
    name: ichabod-proxy
```

Replace the hostname, router name, service name, port, and health command for each project. Traefik's `Host(...)` rule uses literal backticks around the hostname.

### Standard deployment sequence

Ichabod should follow this sequence:

```bash
cd /srv/ichabod/apps/<slug>
docker compose config
docker compose build
docker compose run --rm <test-service-or-command>
git status
git add .
git commit -m "Build <project>"
git push
docker compose up -d --build
docker compose ps
docker compose logs --tail=100
curl --fail https://<slug>.ichabod-crane.net/healthz
```

The exact test command belongs in the project's README. For a static site, the health endpoint may be a normal page. For a database-backed application, readiness should confirm required dependencies without exposing internals.

Source should be pushed before or immediately after deployment. GitHub is the durable source history; the local Docker image is replaceable. An image registry is not necessary while build and runtime remain on one host.

### Routing behavior

When Ichabod starts a new labeled service:

1. The wildcard DNS already sends the hostname to the Elastic IP.
2. The security group admits 80/443.
3. Traefik notices the container through Docker.
4. Its router label associates the hostname with the service.
5. Traefik obtains a TLS certificate through port 80 using ACME.
6. Traefik forwards HTTPS to the internal container port.

**Why no Traefik config file gets edited.** Traefik is running with `--providers.docker=true`, so it holds an open connection to the Docker socket and receives an event every time a container starts or stops. It reads that container's `traefik.*` labels and builds its routing table in memory. The labels in the app's own `compose.yaml` *are* the configuration — there is no `traefik.yml` listing sites, and nothing to reload. Deleting the container withdraws the route the same way.

So a new site costs Ichabod one Compose file and one `docker compose up`. No Traefik edit, no Route 53 record, no security-group change.

### Resource and cleanup policy

Suggested defaults:

| Workload | CPU | Memory |
|---|---:|---:|
| Static/tiny site | 0.25 | 256 MiB |
| Normal app or monitor | 0.50 | 512 MiB |
| Demonstrably heavier app | 1.00 | 1 GiB |

The main agent may adjust these within the host's capacity. Keep the first pilot to roughly five running experiments and one active build. Every experiment needs a review date; stale services should be stopped before their data is deleted.

Safe routine inspection:

```bash
docker ps
docker compose ls
docker system df
df -h
free -h
```

Prune unused build cache and old unreferenced images only after inspecting them. Never automate `docker volume prune`.

