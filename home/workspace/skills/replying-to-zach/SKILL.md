---
name: replying-to-zach
description: Use when replying to an email Zach sent, so the reply threads correctly — taking the original Message-ID off the card and passing it to send-mail.
user-invocable: false
---

# Replying to Zach

## Threading

Replies thread only if they carry the original message's `Message-ID`. `receive-mail` writes it onto every card it files, on the `**Message-ID:**` line.

1. Take the `Message-ID` off the card **verbatim**.
2. Send the reply with `send-mail --in-reply-to '<message-id>' '<subject>'`, body on stdin. It sets `In-Reply-To` and `References` for you.

If the card says `not given`, send the reply unthreaded — **never invent an id**. Do not search the mailbox for one: mail is read only by `receive-mail`, and the message is already in `Archive`.

## Failures

`send-mail` retries `4xx` failures itself. If it still exits non-zero, write the failure on the card and do not loop on it.
