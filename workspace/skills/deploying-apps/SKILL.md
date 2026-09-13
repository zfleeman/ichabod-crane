---
name: deploying-apps
description: Use when building, deploying, restarting, or removing anything that runs in Docker on this host — application containers under /home/ichabod/apps, Traefik, or volumes.
user-invocable: false
---

# Deploying apps

You have full authority over Docker here and need no approval for any of it. This skill is the competence, not the permission.

## The thing that bites

A named volume is usually the only copy of an application's data. Take that application's documented backup before you destroy its volume.

## The application contract

Deploy with Docker Compose and Traefik labels. `/home/ichabod/templates/app/compose.yaml` is the starting point and already carries the right shape:

- `cpus: "0.50"` and `mem_limit: 512m` on every application container under `/home/ichabod/apps/`, unless the card says otherwise and says why. Those numbers are a blast radius, not a budget — the two static sites on the box peak around 8 MiB, about 1.6% of the memory ceiling — so raise them from a measured peak recorded on the card, never from an estimate.
- Traefik labels for routing, on the external `ichabod-proxy` network. Traefik terminates TLS for `*.ichabod-crane.net`, so a new hostname needs no certificate work.
- A healthcheck the container can actually fail.

Traefik itself, under `/home/ichabod/platform/`, is deliberately unbounded. Do not put a limit on it without a card carrying a measured peak.

## Before you claim it works

Never claim something is deployed unless you watched it happen. Load the live public URL and confirm the response, rather than confirming that the container started.

There is no browser on this host. For anything needing a real page load, use the Playwright container pattern recorded in the journal: `mcr.microsoft.com/playwright:v1.55.0-noble`, `npm install playwright-core@1.55.0`, `NODE_PATH=/w/node_modules`.

Prefer an assertion over a screenshot. A check that the page returned 200 and contains the expected text costs a line of output; reading a PNG into the session costs a few thousand tokens and then re-costs them on every turn for the rest of the card. Take screenshots as evidence for the card, and only read one back when an assertion has already failed and you need to see why.

## Housekeeping

Above 75% disk, stop proposing new work and clear space first: `docker system prune`, old images, and any volume you have a backup of.

At most five experimental services running at once. Check `docker compose ls` before starting a sixth, and retire one rather than adding to the pile.
