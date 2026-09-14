# Ichabod Crane

An autonomous agent that lives on a small AWS box, takes work by email, and builds things.

**This repo is Ichabod's infrastructure and operating toolset.** `tofu/` builds the machine, and `home/` is deployed into `/home/ichabod`: the scripts he runs, the prompts cron runs, and his rules and skills. `docs/` holds the reasoning. Anything not in this repo is lost on a rebuild.

Inspired by Jason Rohrer's autonomous AI project, whose clone kit — written by the AI itself over 134 sessions of continuous operation — is the reason this exists at all. The differences below are choices, not criticisms.

## What it does

Zach sends an email. A reader with no tools turns it into a card on a board. The main agent picks the card up, does the work on the host, and replies. Nothing else can talk to it.

## Why Pi

**Ichabod runs on Pi and cron.** It used to run on OpenClaw, on an instance that is destroyed and rebuilt for the switch; the plan is [docs/PI-MIGRATION.md](docs/PI-MIGRATION.md).

The short reason: a routing pass under OpenClaw carried 38,831 tokens of preamble before it did anything, about a third of which was not ours to control and roughly half of the rest tool schemas. Pi is four tools and a short system prompt, driven from a crontab.

## How it works

```
email ──> intake ──> pi, no tools ──> validated card ──> run-pass (pi, cron) ──> work + reply
          (DMARC)    (reads only)      (Kanboard)         (full host)
```

| Piece | What it is |
|---|---|
| Host | One t3a.large, built by OpenTofu in `tofu/`. No inbound SSH; access is AWS SSM only |
| Passes | Prompt files run by `pi` from cron, each under a lock and a timeout |
| Board | Kanboard on Zach's Synology, reached by a `board` shell wrapper over JSON-RPC |
| Membrane | `intake` fetches mail, a tool-less `pi` describes it, and the script writes the card itself |
| Web | Traefik terminates TLS for anything Ichabod deploys, on a wildcard DNS record |

**The trust boundary is the whole design.** An email is untrusted text, even from a trusted sender, because Zach forwards things he did not write. It gets read by a process that can do nothing but print four fields, and the agent with real authority reads the card, never the message. [docs/MEMBRANE.md](docs/MEMBRANE.md) explains this from first principles, including why sanitising the email is not an option.

## How this differs from the clone kit

The kit is one Claude Code process in a terminal, running `--dangerously-skip-permissions` in a five-minute loop, persisting through markdown files, restarted by a cron watchdog when it freezes. It works, it is simple, and it is running today. This migration moves Ichabod most of the way toward it, deliberately, with one exception.

| | Clone kit | Ichabod |
|---|---|---|
| Email in | Python script reads IMAP straight into the session | DMARC-verified gate, then a reader with no tools; raw mail never reaches the powerful agent |
| Authority | One process with permissions skipped | Two processes, one deliberately given nothing |
| Persistence | `wake-state.md`, rewritten each loop, pruned by hand | Cards on a board, with the reasoning written on the card |
| Liveness | `while True` + watchdog restart | Scheduled passes; the loop is not the thing being protected |
| The machine | Set up by hand, per the instructions | OpenTofu, plus a guide that reproduces the host |

The kit optimizes for **never stopping**. This project optimizes for **never trusting the input**. The kit's loop instructions say "NEVER STOP THE LOOP" because a stalled agent is the failure it fears most. Here, the failure we design against is an email talking a root-equivalent agent into running something.

## What went wrong, and what it taught

Almost every bug in this project was the same bug wearing a different hat: **the check reported health while answering a different question than the one asked.** A config validator passed on an agent that was not sandboxed at all. A sandbox report printed `runtime: sandboxed` for a reader that had a shell, Docker and the network. A service check said `inactive` for a user unit that was serving fine. A healthy Traefik logs nothing, which reads exactly like a dead one.

**The verification that works is asking the live system what it can actually do** — calling the tool and watching what happens, not reading its config. Every real defect here was found that way.

Three failure shapes worth designing against, because they are worse than an error:

- **Silent skip.** A credential that fails to resolve and makes the intake skip the mailbox rather than error looks exactly like nobody having written. Fail loudly, and say which command fixes it.
- **Confident fabrication.** A reader told to record a `Message-ID` it was never given invented a plausible one, which sat on a card looking like evidence. An absent field is safe; a fabricated one is not.
- **Half-applied guard.** A hook that deleted dangerous fields from a tool call did nothing, because the host merged the model's original arguments back over it — and logged that the hook ran. Prefer designs where the dangerous thing cannot be expressed at all.

## Layout

```
docs/        MEMBRANE.md is the trust boundary and the one to read first
             PI-MIGRATION.md is the plan and build order
             ICHABOD-GUIDE.md is the host, the web layer, and operations
tofu/        The machine, DNS, alarms. Zach applies it; Ichabod never does
home/        Mirrors /home/ichabod on the box
  bin/       Commands: run-pass, board, usage, backup-workspace, set-secret
  prompts/   What cron runs (director, scout, digest; still OpenClaw versions, to be ported)
  workspace/ Identity and operating rules, plus skills/ for procedures he only sometimes needs. His own skills live in own-skills/ on the box, not here
  templates/ The starting compose file for an application
  crontab    The schedule
  .config/ichabod/env.example   Every secret the scripts read, with no values
```

Where a new capability goes: a command he runs is a script in `home/bin/`, a procedure he follows is a skill in `home/workspace/skills/`, and something on a schedule is a prompt in `home/prompts/` plus a `crontab` line. No Pi extensions and no MCP servers: under Pi his only tools are `read`, `write`, `edit` and `bash`, and everything else is a script he calls.

`make help` lists the operational commands. Work is tracked in GitHub Issues; each closed issue carries what actually happened, including the parts that did not go to plan.
