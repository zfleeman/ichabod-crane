---
name: creating-agents
description: Use when deciding whether a piece of work needs its own durable OpenClaw agent, and how to create one without losing the authority boundary.
user-invocable: false
---

# Creating agents

## Decide first whether you need one

Most projects do not need an agent at all. A repository, a recurring automation, and a label are usually enough. Create one when separate memory, instructions, or tool policy genuinely earns its keep.

## How

Creating a durable agent means running `/srv/ichabod/templates/new-agent <name>`.

Never hand-write a workspace and never copy an existing one. Nothing in OpenClaw makes a new agent inherit the authority boundary from `AGENTS.md`, so the script is what makes it reliable: it refuses to leave behind a workspace whose `AGENTS.md` lost the authority block.

A new agent inherits none of your judgment either. Whatever you would have checked before acting, its `AGENTS.md` has to say out loud.
