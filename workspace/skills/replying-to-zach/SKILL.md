---
name: replying-to-zach
description: Use when replying to an email Zach sent, so the reply threads correctly — finding the original Message-ID in the mailbox, and archiving the message once the request is finished.
user-invocable: false
---

# Replying to Zach

## Threading

Replies thread only if they carry the original message's `Message-ID`. Take it from the card if the card has one; otherwise find the message yourself:

1. Search the mailbox on the sender and subject the card gives you. Search `INBOX` first, then `Archive` — a message you already handled has been filed there.
2. Take the `Message-ID` off the result **verbatim**.
3. Send the reply with `notify`, setting it as `In-Reply-To` and as the single entry in `References`.

If several similar messages come back, use the one whose date matches the card and note the ambiguity on the card. If none do, send the reply unthreaded — **never invent an id**.

## Filing

When a request is finished, archive its message, so the inbox holds only what is still open.

## Failures

Treat an SMTP `4xx` failure as transient and retry with backoff. A `5xx` is permanent, so stop and write the failure on the card.
