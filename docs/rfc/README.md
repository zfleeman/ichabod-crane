# Ichabod RFCs

These five documents are the declarative design for Ichabod — a one-box autonomous OpenClaw workshop. Each one states what a part of the system *is*: the machine, the infrastructure, the host, the agent runtime, and the operating rules. Together they are the design of record.

| RFC | Covers |
|---|---|
| [RFC-01 — Foundations: scope, authority, and accounts](RFC-01-foundations.md) | What the machine is, what Ichabod may do without asking, what it costs, and the dedicated AWS/Claude/GitHub/email identities and secret storage behind it |
| [RFC-02 — Infrastructure: OpenTofu, SSM, and the admin Makefile](RFC-02-infrastructure.md) | The OpenTofu module Zach owns and applies, and the SSM-only administrative path that replaces SSH |
| [RFC-03 — Host baseline and deployment plane](RFC-03-host-and-deployment.md) | Provisioning and securing the Ubuntu host, and the Traefik plus Docker Compose contract that turns a labelled container into a public HTTPS site |
| [RFC-04 — Agent runtime: OpenClaw, agents, and email](RFC-04-agent-runtime.md) | Installing Claude Code and OpenClaw, the workspace identity files, the agent roster and Workboard, and email as the front door |
| [RFC-05 — Autonomy, operations, and recovery](RFC-05-autonomy-and-operations.md) | The recurring automations, the capacity ceilings, and the backup, update, kill-switch, and completion criteria |

## How these become work

Each RFC describes a finished state, not a task list. A GitHub issue should name the RFC it satisfies and the specific part of it, so the issue carries the "what to do" and the RFC carries the "what it should look like when done". The checklists in [RFC-05](RFC-05-autonomy-and-operations.md#completion-criteria) are the acceptance criteria for the system as a whole.

## Status

All five are **Draft — awaiting review**. Mark an RFC `Accepted` once it has been read and its design agreed. When the design itself changes, amend the RFC in a pull request rather than in an issue comment — otherwise the design of record drifts away from what was actually built.
