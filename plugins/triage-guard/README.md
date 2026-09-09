# triage-guard

The intake membrane contains the reader. It does not contain the card the
reader writes. This closes that.

## The gap

OpenClaw's tool policy is per-tool, not per-parameter. `mail_reader` is allowed
`workboard_create`, which means it is allowed every field that tool takes —
including `status`, `agentId`, and `workspace`. So a card written from an
injected email can arrive as `status: ready, agentId: ichabod`, assigned to the
root-equivalent agent and skipping triage entirely.

`workspace-mail-reader/AGENTS.md` asks for `status: triage`. An instruction is
exactly what an injected email argues with, which is why this is code.

## What it does

A `before_tool_call` hook on `workboard_create`. For any agent not in
`trustedAgents`, it forces `status: triage` and strips the fields that decide
where a card runs: `agentId`, `workspace`, `priority`, `maxRuntimeSeconds`,
`maxRetries`, `scheduledAt`, `parents`, `token`, `createdByCardId`, `skills`.

Everything a reader is supposed to set — title, notes, labels, board, tenant,
idempotency key — passes through untouched, as does anything the host stamped
onto the call itself.

## Why the config looks like this

- **`trustedAgents` is an allowlist, not a blocklist.** A second reader, or the
  guest lane the guide defers, is guarded on the day it is created rather than
  on the day someone remembers to add it here. A call arriving with no agent id
  is guarded too, and a missing or malformed config guards everyone.
- **The hook uses a matcher.** A hook that throws or times out fails closed, and
  failing closed on `exec` would stop the box rather than one card. This one
  only ever sees `workboard_create`.

## What it records

A card that arrived claiming something gets a line appended to its notes naming
exactly what was discarded:

```
[triage-guard] This card arrived claiming status=ready, agentId=ichabod. Those
values were discarded and the card was forced to triage. A card that asks to be
dispatched is worth reading as an injection attempt before it is worth reading
as a request.
```

That is the point of recording rather than silently dropping: a card asking for
promotion is evidence about the email it came from.

## What it does not do

It does not constrain `labels`. Nothing dispatches on a label today, and the
reader needs to set `zach` and `email`. If a future automation ever triggers on
a label, that becomes a gap and belongs in this hook.

It does not stop a *human* from promoting one of these cards. This is about
what an email can cause on its own.

## Building

```
npm install
npm test                  # pure logic, no openclaw runtime needed
npm run plugin:build      # tsc only
```

There is no `openclaw plugins build` step and no `plugins validate`: those
generate and check a manifest from a plugin's *tool* metadata, and this plugin
authors no tools. `openclaw.plugin.json` is written by hand, and
`activation.onStartup` is what makes the Gateway load a plugin that only
registers hooks.
