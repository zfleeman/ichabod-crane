# smtp-send

Outbound email for Ichabod. The IMAP plugin OpenClaw ships is receive-only, so
sending is the one piece of this system we build rather than configure.

## What it does

One tool, `smtp_send`, which opens an SMTP submission connection and sends a
plain-text message. Recipient, subject and body come from the caller;
everything that affects deliverability or safety comes from config.

## Why the config looks like this

- **`from` is config, not a parameter.** The envelope sender and the header
  `From` are both set to it. A mismatch between the two is what breaks DMARC
  alignment, so neither is caller-supplied.
- **`allowedRecipients` is enforced here, not in `AGENTS.md`.** An instruction
  is what an injected email argues with, and the card Ichabod reads before
  calling this tool may have been written from an injected email.
- **`password` is a SecretRef.** It resolves before the plugin sees it, so the
  value never reaches model context or `openclaw.json`.
- **`maxPerHour`** is a backstop against an agent stuck in a retry loop, which
  is the traffic shape that gets a submission account throttled. It counts in
  process and resets when the Gateway restarts — that matches the risk, since a
  retry loop happens inside one Gateway lifetime. The daily digest budget is a
  policy in `AGENTS.md`, not something this enforces.

## Threading

`inReplyTo` and `references` are optional parameters, and the caller has to
find the original's `Message-ID` itself, because nothing on a triage card
contains one. The route is `mailbox_search` from the `mailbox` plugin: search
for the sender and subject the card records, take `messageId` off the result,
and pass it here as `inReplyTo` and as the single entry in `references`. That
instruction lives in Ichabod's `AGENTS.md`; this tool only carries whatever it
is handed, and omits both headers when it is handed nothing.

## Building

```
npm install
npm test                  # pure logic, no network, no openclaw runtime needed
npm run plugin:build      # tsc, regenerate the manifest, re-add configContracts
npm run plugin:validate
```

`openclaw plugins build` regenerates `openclaw.plugin.json` from the entry
point and **drops `configContracts`**, which is what tells OpenClaw that
`password` is a SecretRef surface. Without it the runtime type-checks the
unresolved SecretRef object against `"password": string` and the config is
rejected. `plugin:build` re-adds it; do not run the bare `openclaw plugins
build` on its own.
