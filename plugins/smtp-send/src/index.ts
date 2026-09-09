import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import nodemailer from "nodemailer";
import {
  ConfigSchema,
  ParamsSchema,
  assertAllowedRecipient,
  buildMessage,
  checkRateLimit,
  classifySmtpError,
  normalizeAddress,
  type Config,
  type Params,
} from "./smtp.js";

export default defineToolPlugin({
  id: "smtp-send",
  name: "SMTP Send",
  description: "Send outbound email through the mailbox provider's submission service.",
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: "smtp_send",
      label: "SMTP Send",
      description:
        "Send one plain-text email from Ichabod's own address to an allowlisted recipient. " +
        "Use inReplyTo and references to thread a reply under an existing message.",
      parameters: ParamsSchema,
      execute: async (params: Params, config: Config) => {
        // An unresolved SecretRef arrives as an object rather than a string.
        // The imap plugin skips the account silently in this case, which is
        // indistinguishable from a quiet mailbox; fail loudly instead.
        if (typeof config.password !== "string" || config.password.length === 0) {
          throw new Error(
            "smtp_send: the password SecretRef did not resolve. Run `openclaw secrets audit` " +
              "and check `unresolved`. Nothing was sent.",
          );
        }

        assertAllowedRecipient(params.to, config.allowedRecipients);

        // Built before the try, not inside it. A rejected Message-ID is a
        // permanent input error, and classifySmtpError sees no SMTP code on it
        // — so thrown from inside the try it came back labelled "safe to retry
        // with backoff", advising a retry that can only fail identically.
        const message = buildMessage(params, config);
        checkRateLimit(Date.now(), config.maxPerHour);

        const transport = nodemailer.createTransport({
          host: config.host,
          port: config.port,
          secure: config.secure,
          auth: { user: config.user, pass: config.password },
        });

        try {
          const info = await transport.sendMail(message);
          return {
            ok: true,
            messageId: info.messageId,
            accepted: info.accepted,
            to: normalizeAddress(params.to),
          };
        } catch (error) {
          const failure = classifySmtpError(error, config.password);
          throw new Error(
            failure.kind === "retry"
              ? `smtp_send: transient failure, safe to retry with backoff. ${failure.message}`
              : `smtp_send: permanent failure, do not retry. Record it on the card. ${failure.message}`,
          );
        } finally {
          transport.close();
        }
      },
    }),
  ],
});
