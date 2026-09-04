# Ichabod RFCs

These five documents are the declarative design for Ichabod. Each one states what a part of the system *is* — the machine, the infrastructure, the host, the agent runtime, and the operating rules — so a body of work can be described by pointing at an RFC rather than re-explaining the design.

They were split out of [ICHABOD-GUIDE.md](../ICHABOD-GUIDE.md) without rewording. The guide remains the readable narrative walkthrough; the RFCs are the design of record. If the two ever disagree, the RFC wins and the guide should be corrected.

| RFC | Covers | Guide sections |
|---|---|---|
| [RFC-0001 — Foundations: scope, authority, and accounts](RFC-0001-foundations.md) | What the machine is, what Ichabod may do without asking, what it costs, and the dedicated AWS/Claude/GitHub/email identities and secret storage behind it | 1–4 |
| [RFC-0002 — Infrastructure: OpenTofu, SSM, and the admin Makefile](RFC-0002-infrastructure.md) | The OpenTofu module Zach owns and applies, and the SSM-only administrative path that replaces SSH | 5, 7 |
| [RFC-0003 — Host baseline and deployment plane](RFC-0003-host-and-deployment.md) | Provisioning and securing the Ubuntu host, and the Traefik plus Docker Compose contract that turns a labelled container into a public HTTPS site | 6, 10 |
| [RFC-0004 — Agent runtime: OpenClaw, agents, and email](RFC-0004-agent-runtime.md) | Installing Claude Code and OpenClaw, the workspace identity files, the agent roster and Workboard, and email as the front door | 8, 9, 11 |
| [RFC-0005 — Autonomy, operations, and recovery](RFC-0005-autonomy-and-operations.md) | The recurring automations, the capacity ceilings, and the backup, update, kill-switch, and completion criteria | 12, 14 |

## What stayed in the guide

Two parts of the guide are narrative rather than design, so they were not split out. The Minesweeper walkthrough (section 13) illustrates the whole system end to end and would have to be cut across all five RFCs to fit here. The implementation sequence and reference list (section 15) describe the order to build things in, which is scheduling rather than design — that ordering is what GitHub issues are for.

## How these become work

Each RFC describes a finished state. A GitHub issue should name the RFC it satisfies and the specific part of it, so the issue carries the "what to do" and the RFC carries the "what it should look like when done". The completion checklists in [RFC-0005](RFC-0005-autonomy-and-operations.md#completion-criteria) are the acceptance criteria for the system as a whole.

## Status

All five are **Draft — awaiting review**. Mark an RFC `Accepted` once it has been read and its design agreed; amend it in a pull request rather than in an issue comment when the design itself changes.
