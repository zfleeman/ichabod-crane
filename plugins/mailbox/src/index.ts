import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { ImapFlow } from "imapflow";
import {
  ConfigSchema,
  SearchParamsSchema,
  TargetSchema,
  assertOneTarget,
  buildSearchCriteria,
  projectHeaders,
  resolveLimit,
  type Config,
  type HeaderResult,
  type SearchParams,
  type Target,
} from "./mailbox.js";

function requirePassword(config: Config): string {
  if (typeof config.password !== "string" || config.password.length === 0) {
    throw new Error(
      "mailbox: the password SecretRef did not resolve. Run `openclaw secrets audit` " +
        "and check `unresolved`. Nothing was done.",
    );
  }
  return config.password;
}

/**
 * Connect, do one thing, disconnect. There is deliberately no persistent
 * connection and no watcher: the IMAP trigger plugin stays the only path by
 * which mail enters a session, and this tool only ever acts on messages
 * someone already asked about.
 */
async function withMailbox<T>(config: Config, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: requirePassword(config) },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function fetchHeaders(client: ImapFlow, uids: number[], limit: number): Promise<HeaderResult[]> {
  if (uids.length === 0) return [];
  const wanted = uids.slice(-limit);
  const results: HeaderResult[] = [];
  for await (const message of client.fetch(
    wanted.join(","),
    { uid: true, envelope: true, flags: true, internalDate: true },
    { uid: true },
  )) {
    results.push(projectHeaders(message as unknown as Record<string, any>));
  }
  return results.sort((left, right) => right.uid - left.uid);
}

async function resolveUid(client: ImapFlow, target: Target): Promise<number> {
  assertOneTarget(target);
  if (target.uid !== undefined) return target.uid;
  const found = await client.search({ header: { "message-id": target.messageId! } }, { uid: true });
  const uids = Array.isArray(found) ? found : [];
  if (uids.length === 0) throw new Error(`mailbox: no message with Message-ID ${target.messageId}.`);
  return uids[uids.length - 1]!;
}

export default defineToolPlugin({
  id: "mailbox",
  name: "Mailbox",
  description: "Search and manage the mailbox the IMAP trigger watches. Never returns message bodies.",
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: "mailbox_search",
      label: "Mailbox Search",
      description:
        "Find messages by sender, subject, body text, date or read state. Body matching happens " +
        "on the mail server; results are headers only and never include message text. Use this to " +
        "find the message a triage card came from.",
      parameters: SearchParamsSchema,
      execute: async (params: SearchParams, config: Config) =>
        withMailbox(config, async (client) => {
          const found = await client.search(buildSearchCriteria(params), { uid: true });
          const uids = Array.isArray(found) ? found : [];
          const messages = await fetchHeaders(client, uids, resolveLimit(params.limit, config.maxResults));
          return { matched: uids.length, returned: messages.length, messages };
        }),
    }),
    tool({
      name: "mailbox_fetch",
      label: "Mailbox Fetch",
      description:
        "Look up one message's headers by Message-ID or UID. Returns sender, subject, date and " +
        "flags. Does not return the body — read the triage card for what the message said.",
      parameters: TargetSchema,
      execute: async (params: Target, config: Config) =>
        withMailbox(config, async (client) => {
          const uid = await resolveUid(client, params);
          const [message] = await fetchHeaders(client, [uid], 1);
          if (!message) throw new Error(`mailbox: no message at uid ${uid}.`);
          return message;
        }),
    }),
    tool({
      name: "mailbox_mark_read",
      label: "Mailbox Mark Read",
      description: "Mark one message as read.",
      parameters: TargetSchema,
      execute: async (params: Target, config: Config) =>
        withMailbox(config, async (client) => {
          const uid = await resolveUid(client, params);
          const ok = await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          return { uid, markedRead: ok };
        }),
    }),
    tool({
      name: "mailbox_archive",
      label: "Mailbox Archive",
      description: "Move one handled message out of the inbox into the archive folder.",
      parameters: TargetSchema,
      execute: async (params: Target, config: Config) =>
        withMailbox(config, async (client) => {
          const uid = await resolveUid(client, params);
          await client.messageMove(String(uid), config.archiveMailbox, { uid: true });
          return { uid, movedTo: config.archiveMailbox };
        }),
    }),
  ],
});
