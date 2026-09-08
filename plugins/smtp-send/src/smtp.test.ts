import { describe, expect, it } from "vitest";
import {
  assertAllowedRecipient,
  buildMessage,
  checkRateLimit,
  classifySmtpError,
  normalizeAddress,
} from "./smtp.js";

const config = {
  host: "smtp.example.net",
  port: 587,
  secure: false,
  user: "ichabod@ichabod-crane.net",
  password: "hunter2",
  from: "ichabod@ichabod-crane.net",
  allowedRecipients: ["zach@example.com"],
  maxPerHour: 10,
};

describe("recipient allowlist", () => {
  it("accepts an allowlisted address regardless of casing or spacing", () => {
    expect(() => assertAllowedRecipient("  Zach@Example.COM ", config.allowedRecipients)).not.toThrow();
  });

  it("refuses an address that is not on the list", () => {
    expect(() => assertAllowedRecipient("attacker@evil.example", config.allowedRecipients)).toThrow(/refusing to send/);
  });

  it("refuses everything when the list is empty", () => {
    expect(() => assertAllowedRecipient("zach@example.com", [])).toThrow(/refusing to send/);
  });

  it("refuses a lookalike that only shares the local part", () => {
    expect(() => assertAllowedRecipient("zach@evil.example", config.allowedRecipients)).toThrow(/refusing to send/);
  });

  it("refuses a value that is not an address at all", () => {
    expect(() => assertAllowedRecipient("zach", config.allowedRecipients)).toThrow(/not an email address/);
  });
});

describe("message construction", () => {
  it("sets envelope sender and header From to the configured address, not the caller's", () => {
    const mail = buildMessage({ to: "zach@example.com", subject: "s", body: "b" }, config);
    expect(mail.from).toBe(config.from);
    expect(mail.envelope.from).toBe(config.from);
  });

  it("puts the display name on the header From and keeps the envelope bare", () => {
    const named = { ...config, fromName: "Ichabod Crane" };
    const mail = buildMessage({ to: "zach@example.com", subject: "s", body: "b" }, named);
    expect(mail.from).toEqual({ name: "Ichabod Crane", address: config.from });
    expect(mail.envelope.from).toBe(config.from);
  });

  it("falls back to the bare address when no display name is configured", () => {
    const mail = buildMessage({ to: "zach@example.com", subject: "s", body: "b" }, config);
    expect(mail.from).toBe(config.from);
  });

  it("omits threading headers when no reference is given", () => {
    const mail = buildMessage({ to: "zach@example.com", subject: "s", body: "b" }, config);
    expect(mail).not.toHaveProperty("inReplyTo");
    expect(mail).not.toHaveProperty("references");
  });

  it("carries threading headers through when given", () => {
    const mail = buildMessage(
      { to: "zach@example.com", subject: "s", body: "b", inReplyTo: "<a@mail>", references: ["<a@mail>"] },
      config,
    );
    expect(mail.inReplyTo).toBe("<a@mail>");
    expect(mail.references).toEqual(["<a@mail>"]);
  });
});

describe("error classification", () => {
  it("treats 4xx as retryable", () => {
    expect(classifySmtpError({ responseCode: 451, message: "try later" }).kind).toBe("retry");
  });

  it("treats 5xx as permanent", () => {
    expect(classifySmtpError({ responseCode: 550, message: "no such user" }).kind).toBe("stop");
  });

  it("treats a codeless failure as retryable", () => {
    expect(classifySmtpError(new Error("ECONNRESET")).kind).toBe("retry");
  });

  it("redacts the password if it ever appears in an error", () => {
    const failure = classifySmtpError({ responseCode: 535, message: "auth failed for hunter2" }, "hunter2");
    expect(failure.message).not.toContain("hunter2");
    expect(failure.message).toContain("[redacted]");
  });
});

describe("rate limit", () => {
  it("allows sends up to the cap and refuses the one after", () => {
    const times: number[] = [];
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) checkRateLimit(now, 3, times);
    expect(() => checkRateLimit(now, 3, times)).toThrow(/rate limit reached/);
  });

  it("forgets sends older than an hour", () => {
    const times: number[] = [];
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) checkRateLimit(now, 3, times);
    expect(() => checkRateLimit(now + 60 * 60 * 1000 + 1, 3, times)).not.toThrow();
  });
});

describe("address normalization", () => {
  it("lowercases and trims", () => {
    expect(normalizeAddress("  ZACH@Example.com ")).toBe("zach@example.com");
  });
});
