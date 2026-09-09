import { Type, type Static } from "typebox";

/**
 * A SecretRef as it sits in openclaw.json before resolution. Plugin config is
 * validated when written, long before the runtime resolves anything, so the
 * schema has to accept this shape as well as the resolved string. See #40.
 */
const SecretRefSchema = Type.Object({
  source: Type.String(),
  provider: Type.String(),
  id: Type.String(),
});

export const ConfigSchema = Type.Object({
  host: Type.String({ description: "IMAP host." }),
  port: Type.Number({ description: "IMAP port. 993 for implicit TLS." }),
  secure: Type.Boolean({ description: "True for implicit TLS on 993." }),
  user: Type.String({ description: "IMAP username." }),
  password: Type.Union([Type.String(), SecretRefSchema], {
    description: "IMAP password. Use a SecretRef; it resolves before the tool runs.",
  }),
  mailbox: Type.String({ description: "Mailbox to search and act on. Usually INBOX." }),
  archiveMailbox: Type.String({ description: "Destination for archived messages." }),
  maxResults: Type.Number({ description: "Hard ceiling on messages returned by one search." }),
});

export type Config = Static<typeof ConfigSchema>;

export const SearchParamsSchema = Type.Object({
  from: Type.Optional(Type.String({ description: "Match the From header." })),
  subject: Type.Optional(Type.String({ description: "Match the Subject header." })),
  body: Type.Optional(
    Type.String({
      description:
        "Match text in the message body. Matching happens on the mail server; " +
        "body text is never returned.",
    }),
  ),
  since: Type.Optional(Type.String({ description: "On or after this date, YYYY-MM-DD." })),
  before: Type.Optional(Type.String({ description: "Strictly before this date, YYYY-MM-DD." })),
  seen: Type.Optional(Type.Boolean({ description: "True for read messages, false for unread." })),
  limit: Type.Optional(Type.Number({ description: "Maximum messages to return." })),
});

export type SearchParams = Static<typeof SearchParamsSchema>;

export const TargetSchema = Type.Object({
  messageId: Type.Optional(Type.String({ description: "Message-ID, angle brackets included." })),
  uid: Type.Optional(Type.Number({ description: "IMAP UID within the configured mailbox." })),
});

export type Target = Static<typeof TargetSchema>;

/** A message as this plugin is ever willing to describe it. */
export type HeaderResult = {
  uid: number;
  messageId: string | undefined;
  from: string | undefined;
  to: string | undefined;
  subject: string | undefined;
  date: string | undefined;
  flags: string[];
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function parseDate(value: string, field: string): Date {
  if (!DATE_PATTERN.test(value)) throw new Error(`mailbox: ${field} must look like YYYY-MM-DD, got "${value}".`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`mailbox: ${field} is not a real date: "${value}".`);
  return parsed;
}

/**
 * Build IMAP search criteria. Everything here is evaluated by the mail server,
 * including `body` — that is the whole point. Ichabod can find a message by
 * what it says without the text ever entering its context.
 */
export function buildSearchCriteria(params: SearchParams): Record<string, unknown> {
  const criteria: Record<string, unknown> = {};
  if (params.from) criteria.from = params.from;
  if (params.subject) criteria.subject = params.subject;
  if (params.body) criteria.body = params.body;
  if (params.since) criteria.since = parseDate(params.since, "since");
  if (params.before) criteria.before = parseDate(params.before, "before");
  if (typeof params.seen === "boolean") criteria.seen = params.seen;
  if (Object.keys(criteria).length === 0) {
    throw new Error("mailbox: give at least one search term. Refusing to return the whole mailbox.");
  }
  return criteria;
}

export function resolveLimit(requested: number | undefined, max: number): number {
  if (requested === undefined) return max;
  if (!Number.isInteger(requested) || requested < 1) throw new Error("mailbox: limit must be a positive integer.");
  return Math.min(requested, max);
}

/**
 * Project a fetched message down to headers.
 *
 * This is an explicit allowlist rather than a delete-list on purpose. `ichabod`
 * runs unsandboxed with full host authority, and the intake membrane exists to
 * keep untrusted email text out of it. A blacklist quietly leaks whatever field
 * a future library version adds; a whitelist cannot.
 */
export function projectHeaders(message: Record<string, any>): HeaderResult {
  const envelope = (message.envelope ?? {}) as Record<string, any>;
  const address = (list: unknown): string | undefined => {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    return list
      .map((entry: Record<string, any>) => (entry?.name ? `${entry.name} <${entry.address}>` : entry?.address))
      .filter(Boolean)
      .join(", ");
  };
  const date = envelope.date ?? message.internalDate;
  return {
    uid: message.uid,
    messageId: envelope.messageId,
    from: address(envelope.from),
    to: address(envelope.to),
    subject: envelope.subject,
    date: date instanceof Date ? date.toISOString() : date,
    flags: message.flags instanceof Set ? [...message.flags] : Array.isArray(message.flags) ? message.flags : [],
  };
}

/** Exactly one of messageId or uid, so "which message" is never ambiguous. */
export function assertOneTarget(target: Target): void {
  const given = [target.messageId, target.uid].filter((value) => value !== undefined);
  if (given.length !== 1) {
    throw new Error("mailbox: give exactly one of messageId or uid.");
  }
  if (target.uid !== undefined && (!Number.isInteger(target.uid) || target.uid < 1)) {
    throw new Error("mailbox: uid must be a positive integer.");
  }
}
