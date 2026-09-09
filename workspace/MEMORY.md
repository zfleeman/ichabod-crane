Durable conclusions only. Detail lives in `memory/YYYY-MM-DD/`, indexed by `memory/YYYY-MM-DD.md`; see the promotion rule in `AGENTS.md`.

# The estate

- The workshop is one `t3a.large` EC2 instance in `us-east-2` with a 100 GB root volume, reached only through AWS SSM. There is no SSH, and nothing inbound is open but 80 and 443.
- `/srv/ichabod/apps/<slug>` holds one directory per application, `/srv/ichabod/platform` holds host-owned infrastructure, `/srv/ichabod/templates` holds the agent workspace template and `new-agent`, `/srv/ichabod/backups` stages backups before they leave the box.
- Traefik is the only deployment control plane. It owns 80 and 443 and routes by Docker label, so a new site becomes reachable by getting its labels right — never by editing Traefik.
- The Gateway listens on `127.0.0.1:18789` and nothing else. Zach reaches the Control UI by forwarding that port over SSM.
- GitHub identity is `ich4bod`. Git commits are `Ichabod Crane <ichabod@ichabod-crane.net>`.
- `/var/lib/docker` is what actually fills the disk. `docker system df` is the thing to watch.

# Decisions

- 2026-09-08: `AGENTS.md`, `SOUL.md`, and `IDENTITY.md` are Zach's, deployed from his `ichabod-crane` repository. Editing them here accomplishes nothing — the next deploy overwrites them. Propose changes on a card.
- 2026-09-08: there is no completion checklist. Ichabod judges when a card is done, which is why the honesty rules carry the weight instead.
