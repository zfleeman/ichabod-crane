#!/usr/bin/env python3
"""
Example email checking script for autonomous AI.
This shows the pattern — your AI will write its own version.
You don't need to run this directly; it's a reference for the AI.
"""

import imaplib
import smtplib
import email
from email.mime.text import MIMEText
from email.header import decode_header

# These should match your credentials.txt
IMAP_HOST = "127.0.0.1"
IMAP_PORT = 1143
SMTP_HOST = "127.0.0.1"
SMTP_PORT = 1025
EMAIL_ADDR = "your-ai@example.com"
EMAIL_PASS = "your-bridge-password"


def check_inbox():
    """Check for new emails and return them."""
    imap = imaplib.IMAP4(IMAP_HOST, IMAP_PORT)
    imap.login(EMAIL_ADDR, EMAIL_PASS)
    imap.select("INBOX")

    status, messages = imap.search(None, "ALL")
    all_ids = messages[0].split()
    total = len(all_ids)

    print(f"Total inbox: {total}")

    # Read recent emails
    recent_ids = all_ids[-10:]
    for eid in reversed(recent_ids):
        status, msg_data = imap.fetch(eid, "(RFC822)")
        msg = email.message_from_bytes(msg_data[0][1])

        from_addr = msg.get("From", "Unknown")
        subject = msg.get("Subject", "(no subject)")
        date = msg.get("Date", "")

        # Decode subject if needed
        if subject:
            decoded = decode_header(subject)
            subject = " ".join(
                [
                    part.decode(enc or "utf-8") if isinstance(part, bytes) else part
                    for part, enc in decoded
                ]
            )

        # Get body
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    payload = part.get_payload(decode=True)
                    if payload:
                        body = payload.decode("utf-8", errors="replace")
                        break
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                body = payload.decode("utf-8", errors="replace")

        print(f"From: {from_addr}")
        print(f"Subject: {subject}")
        print(f"Date: {date}")
        print(f"Body: {body[:500]}")
        print("---")

    imap.logout()


def send_email(to_addr, subject, body):
    """Send an email."""
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_ADDR
    msg["To"] = to_addr

    smtp = smtplib.SMTP(SMTP_HOST, SMTP_PORT)
    smtp.starttls()
    smtp.login(EMAIL_ADDR, EMAIL_PASS)
    smtp.send_message(msg)
    smtp.quit()
    print(f"Sent email to {to_addr}")


if __name__ == "__main__":
    check_inbox()
