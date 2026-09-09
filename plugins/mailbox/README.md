# mailbox

Mailbox management for Ichabod. The IMAP trigger plugin OpenClaw ships is
strictly receive-only — it never moves a message, never changes a flag, and
never sees mail that predates it. So nothing archives a handled request, nothing
marks anything read, and nothing finds an email from last week.

## Tools

- `mailbox_search` — find messages by sender, subject, body text, date or read
  state
- `mailbox_fetch` — one message's headers, by `Message-ID` or UID
- `mailbox_mark_read` — set `\Seen` on one message
- `mailbox_archive` — move one handled message to the archive folder

## It never returns a message body

This is the point of the design, not an omission.

`ichabod` runs unsandboxed with full host authority and Docker. The whole intake
membrane — a separate sandboxed `mail_reader` whose only possible output is one
triage card — exists to keep untrusted email text out of that session. A tool
that hands back message bodies is a side door into exactly what the membrane
closes.

Searching a body and returning a body are different operations, and only the
second is dangerous. IMAP evaluates `BODY` matching on the mail server and
returns message numbers, so Ichabod can find the message where Zach mentioned
Minesweeper without the text ever crossing into its context.

`projectHeaders` is therefore an explicit allowlist of seven fields rather than
a blacklist of dangerous ones. A blacklist silently leaks whatever field a
future library version adds; a whitelist cannot. There is a test that feeds it a
message carrying `source`, `body`, `text`, `html` and `preview` and asserts none
of it survives.

Two honest caveats. Search results leak a little — a hit confirms a term is
present, so a determined adversary could probe content a term at a time. That is
a far narrower channel than handing over the text, and it needs an actively
adversarial agent issuing many queries. And it means no snippets or previews,
ever: a preview is a body in a smaller font.

## What a card can name

The triage card records no `Message-ID` — the IMAP plugin never passes one to
the reader (#37). So `mailbox_search` on the sender and subject the card *does*
record, within its arrival window, is the only route from a card back to its
message. Search returns the real `Message-ID`, which is what #15 needs to thread
a reply.

Verify the message that comes back matches the card before acting on it. The
card was written by the component that reads hostile text.

## No polling

There is no persistent connection and no watcher. Every tool call connects, does
one thing, and disconnects. The IMAP trigger stays the only path by which mail
first enters a session; this tool only ever touches messages someone already
asked about.

## Building

```
npm install
npm test
npm run plugin:build
npm run plugin:validate
```

`openclaw plugins build` regenerates the manifest and drops `configContracts`,
which is what declares `password` as a SecretRef surface. `plugin:build` re-adds
it. See `plugins/smtp-send/README.md` for why that matters.
