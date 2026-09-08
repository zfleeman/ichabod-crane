import { Type, type Static } from "typebox";

export const ConfigSchema = Type.Object({
  host: Type.String({ description: "SMTP submission host." }),
  port: Type.Number({ description: "Submission port. 587 for STARTTLS." }),
  secure: Type.Boolean({ description: "True only for implicit TLS on 465." }),
  user: Type.String({ description: "SMTP username." }),
  password: Type.String({ description: "SMTP password. Use a SecretRef." }),
  from: Type.String({ description: "Envelope sender and header From. Must match." }),
  allowedRecipients: Type.Array(Type.String(), {
    description: "Addresses this tool may send to. Empty means send to nobody.",
  }),
  maxPerHour: Type.Number({ description: "Sends allowed per rolling hour." }),
});

export type Config = Static<typeof ConfigSchema>;

export const ParamsSchema = Type.Object({
  to: Type.String({ description: "Recipient address. Must be on the allowlist." }),
  subject: Type.String({ description: "Subject line." }),
  body: Type.String({ description: "Plain text body." }),
  inReplyTo: Type.Optional(
    Type.String({ description: "Message-ID of the message being replied to, angle brackets included." }),
  ),
  references: Type.Optional(
    Type.Array(Type.String(), { description: "Message-IDs of the thread so far, oldest first." }),
  ),
});

export type Params = Static<typeof ParamsSchema>;

/** Lowercase and trim so allowlist comparison is not defeated by casing or spacing. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The recipient allowlist lives here rather than in AGENTS.md on purpose: an
 * instruction is what an injected email argues with, and a card written from an
 * injected email is what Ichabod reads before calling this.
 */
export function assertAllowedRecipient(to: string, allowed: readonly string[]): void {
  const target = normalizeAddress(to);
  if (!target.includes("@")) throw new Error(`smtp_send: "${to}" is not an email address.`);
  if (!allowed.some((entry) => normalizeAddress(entry) === target)) {
    throw new Error(
      `smtp_send: refusing to send to ${target}. Only the configured allowlist is permitted, ` +
        `and it is set in plugin config rather than by instruction.`,
    );
  }
}

/**
 * Envelope sender and header From are both config.from. A mismatch between them
 * is what breaks DMARC alignment, so neither is caller-supplied.
 */
export function buildMessage(params: Params, config: Config) {
  return {
    envelope: { from: config.from, to: normalizeAddress(params.to) },
    from: config.from,
    to: normalizeAddress(params.to),
    subject: params.subject,
    text: params.body,
    ...(params.inReplyTo ? { inReplyTo: params.inReplyTo } : {}),
    ...(params.references?.length ? { references: params.references } : {}),
  };
}

export type SmtpFailure = { kind: "retry" | "stop"; message: string };

/**
 * 4xx is a transient refusal worth retrying with backoff; 5xx is permanent and
 * should be recorded on the card instead. Anything without a code (DNS, TLS,
 * socket) is treated as retryable, since those are usually transient too.
 */
export function classifySmtpError(error: unknown, secret?: string): SmtpFailure {
  const err = error as { responseCode?: number; message?: string } | undefined;
  const raw = err?.message ?? String(error);
  // The password should never appear in an SMTP error, but redact defensively:
  // this text reaches a transcript and a Workboard card.
  const message = secret && secret.length > 0 ? raw.split(secret).join("[redacted]") : raw;
  const code = err?.responseCode;
  if (typeof code === "number" && code >= 500) return { kind: "stop", message };
  return { kind: "retry", message };
}

/**
 * A rolling in-process cap. This resets when the Gateway restarts, which is
 * fine for the risk it addresses: the named failure is an agent stuck in a
 * retry loop, and that happens inside a single Gateway lifetime. The daily
 * digest budget is a policy in AGENTS.md, not something this enforces.
 */
const sendTimes: number[] = [];

export function checkRateLimit(now: number, maxPerHour: number, times: number[] = sendTimes): void {
  const cutoff = now - 60 * 60 * 1000;
  while (times.length > 0 && times[0]! < cutoff) times.shift();
  if (times.length >= maxPerHour) {
    throw new Error(
      `smtp_send: rate limit reached (${maxPerHour} sends per hour). ` +
        `Nothing was sent. This is a backstop against retry loops, not a delivery failure.`,
    );
  }
  times.push(now);
}
