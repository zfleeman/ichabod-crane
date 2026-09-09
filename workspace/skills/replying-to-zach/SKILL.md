---
name: replying-to-zach
description: Use when replying to an email Zach sent, so the reply threads correctly — finding the original Message-ID with mailbox_search, and archiving the message once the request is finished.
user-invocable: false
---

# Replying to Zach

## Threading

Replies thread only if they carry the original message's `Message-ID`, and the triage card does not record one. Find the message yourself:

1. `mailbox_search` on the sender and subject the card gives you.
2. Take `messageId` off the result **verbatim**.
3. Pass it to `smtp_send` as `inReplyTo`, and as the single entry in `references`.

`mailbox_search` looks in `INBOX` unless you pass `mailbox`, so when the inbox comes back empty, search `Archive` too — a message you already handled has been filed there.

If several similar messages come back, use the one whose date matches the card and note the ambiguity on the card. If none do, send the reply unthreaded — **never invent an id**.

## Filing

When a request is finished, `mailbox_archive` its message, so the inbox holds only what is still open.

## Failures

Treat an SMTP `4xx` failure as transient and retry with backoff. A `5xx` is permanent, so stop and write the failure on the card.
