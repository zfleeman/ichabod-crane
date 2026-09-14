# Ichabod Crane

An autonomous agent that lives on a small AWS box, takes work by email, and builds things.

**This repo is Ichabod's infrastructure and operating toolset.** `tofu/` builds the machine, and `home/` is deployed into `/home/ichabod`: the scripts he runs, the prompts cron runs, and his rules and skills. `docs/` holds the reasoning. Anything not in this repo is lost on a rebuild.

Inspired by Jason Rohrer's autonomous AI project, whose clone kit — written by the AI itself over 134 sessions of continuous operation — is the reason this exists at all. The differences below are choices, not criticisms.

## What it does

Zach sends an email. A reader with no tools turns it into a card on a board. The main agent picks the card up, does the work on the host, and replies. Nothing else can talk to it.

## Status

The repository describes the box as it should be, not as it is today. Work still to do is in [GitHub Issues](https://github.com/zfleeman/ichabod-crane/issues).

## Why Pi

**Ichabod runs on Pi and cron.** Every turn re-sends the model's preamble, so framework tokens come out of the same allowance as the work. Pi is four tools and a short system prompt, driven from a crontab, and [docs/RUNTIME.md](docs/RUNTIME.md#why-pi-and-cron) has the reasoning.

## How it works

```
email ──> receive-mail ──> pi, no tools ──> validated card ──> run (pi, cron) ──> work + send-mail
          (DMARC)          (reads only)      (Kanboard)         (full host)
```

| Piece | What it is |
|---|---|
| Host | One EC2 instance, built by OpenTofu in `tofu/`. No inbound SSH; access is AWS SSM only |
| Passes | Prompt files run by `pi` from cron, each under a lock and a timeout |
| Board | Kanboard on Zach's Synology, reached by a `board` shell wrapper over JSON-RPC |
| Membrane | `receive-mail` fetches mail, a tool-less `pi` describes it, and the script writes the card itself |
| Web | Traefik terminates TLS for anything Ichabod deploys, on a wildcard DNS record |

**The trust boundary is the whole design.** An email is untrusted text, even from a trusted sender, because Zach forwards things he did not write. It gets read by a process that can do nothing but print four fields, and the agent with real authority reads the card, never the message. [docs/MEMBRANE.md](docs/MEMBRANE.md) explains this from first principles, including why sanitising the email is not an option.

## How this differs from the clone kit

The kit is one Claude Code process in a terminal, running `--dangerously-skip-permissions` in a five-minute loop, persisting through markdown files, restarted by a cron watchdog when it freezes. It works, it is simple, and it is running today. Ichabod is deliberately close to it, with one exception.

| | Clone kit | Ichabod |
|---|---|---|
| Email in | Python script reads IMAP straight into the session | DMARC-verified gate, then a reader with no tools; raw mail never reaches the powerful agent |
| Authority | One process with permissions skipped | Two processes, one deliberately given nothing |
| Persistence | `wake-state.md`, rewritten each loop, pruned by hand | Cards on a board, with the reasoning written on the card |
| Liveness | `while True` + watchdog restart | Scheduled passes; the loop is not the thing being protected |
| The machine | Set up by hand, per the instructions | OpenTofu, plus a guide that reproduces the host |

The kit optimizes for **never stopping**. This project optimizes for **never trusting the input**. The kit's loop instructions say "NEVER STOP THE LOOP" because a stalled agent is the failure it fears most. Here, the failure we design against is an email talking a root-equivalent agent into running something.

## Design principles

- **Verify by asking the live system.** Call the tool and watch what happens instead of reading its config. A check can report healthy while answering a different question than the one asked.
- **Fail loudly.** A skipped step that looks like a quiet day is worse than an error. Say what failed and which command fixes it.
- **Never let a model fill a gap.** Ask a model only for what it was given. An absent field is safe; an invented one looks like evidence.
- **Make the dangerous thing impossible to express.** A guard that strips bad input can be bypassed or silently skipped. A design with no place for the bad input needs no guard.
- **Code is the source of truth.** A rule, a limit or a schedule lives in the script or config that enforces it, and the docs explain why.

## Layout

```
docs/        MEMBRANE.md is the trust boundary and the one to read first
             RUNTIME.md is why the runtime is Pi, cron, and a board
             ICHABOD-GUIDE.md is the host, the web layer, and operations
tofu/        The machine, DNS, alarms. Zach applies it; Ichabod never does
scripts/     deploy and install-home, behind make deploy
tests/       Unit tests for receive-mail and send-mail, run with make test
home/        Mirrors /home/ichabod on the box
  bin/       Commands Ichabod and cron run. Each script's header says what it does
  prompts/   What cron runs, one file per pass
  workspace/ AGENTS.md and MEMORY.md, both in every run's prompt, plus skills/. MEMORY.md is seeded once, then Ichabod's
  platform/  Traefik's compose file, the one piece of the web layer that is not an application
  templates/ The starting compose file for an application
  crontab    The shipped schedule, installed by make cron
  .config/ichabod/env.example   Every secret the scripts read, with no values

Only on the box, never in this repo:
  /home/ichabod/workspace/memory/              Ichabod's journal
  /home/ichabod/workspace/own-skills/          Skills Ichabod writes himself
  /home/ichabod/log/                           One log per run, plus cost.jsonl and usage.jsonl
  /home/ichabod/.local/state/                  Locks, and the success markers health reads
  /home/ichabod/apps/<slug>/                   One directory per application, source on GitHub
  /home/ichabod/src/                           Ichabod's checkouts, such as his fork of this repo
  /home/ichabod/backups/                       Staging before a backup leaves the box
```

Where a new capability goes: a command he runs is a script in `home/bin/`, a procedure he follows is a skill in `home/workspace/skills/`, and something on a schedule is a prompt in `home/prompts/` plus a `crontab` line. One Pi extension, `pi-web-access`, for searching and reading the web, and no MCP servers: his tools are Pi's `read`, `write`, `edit` and `bash` plus that extension's, and everything else is a script he calls.

`make help` lists the operational commands. Work is tracked in GitHub Issues; each closed issue carries what actually happened, including the parts that did not go to plan.
