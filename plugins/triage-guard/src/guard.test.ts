import { describe, expect, it } from "vitest";
import { guardCardParams, isTrustedAgent, readTrustedAgents } from "./guard.js";

describe("trust", () => {
  it("trusts only the configured agents", () => {
    expect(isTrustedAgent("ichabod", ["ichabod"])).toBe(true);
    expect(isTrustedAgent("mail_reader", ["ichabod"])).toBe(false);
  });

  // A second reader, or a guest lane, should be guarded on the day it is
  // created rather than on the day someone remembers to add it here.
  it("guards an agent nobody has configured", () => {
    expect(isTrustedAgent("some_new_reader", ["ichabod"])).toBe(false);
    expect(isTrustedAgent(undefined, ["ichabod"])).toBe(false);
  });

  it("guards everything when config is missing or malformed", () => {
    expect(readTrustedAgents(undefined)).toEqual([]);
    expect(readTrustedAgents({ trustedAgents: "ichabod" })).toEqual([]);
    expect(readTrustedAgents({ trustedAgents: ["ichabod", 7, ""] })).toEqual(["ichabod"]);
  });
});

describe("neutralizing a promoted card", () => {
  // The host merges a hook's params over the original call, so a field this
  // guard removed would come straight back. Every one of these asserts the
  // field is present and harmless, never that it is gone.
  it("overwrites rather than deletes", () => {
    const decision = guardCardParams({ title: "t", status: "ready", agentId: "ichabod", priority: "urgent" });
    if (decision.kind !== "rewrite") throw new Error(`expected a rewrite, got ${decision.kind}`);
    expect(decision.params.status).toBe("triage");
    expect(decision.params.agentId).toBe("");
    expect(decision.params.priority).toBe("normal");
    expect(decision.changed).toEqual(["status", "agentId", "priority"]);
  });

  it("replaces a chosen workspace with a scratch one", () => {
    const decision = guardCardParams({ title: "t", workspace: { kind: "dir", path: "/home/openclaw" } });
    if (decision.kind !== "rewrite") throw new Error(`expected a rewrite, got ${decision.kind}`);
    expect(decision.params.workspace).toEqual({ kind: "scratch" });
  });

  it("records what arrived in the notes", () => {
    const decision = guardCardParams({ title: "t", notes: "From: someone", status: "ready", agentId: "ichabod" });
    if (decision.kind !== "rewrite") throw new Error(`expected a rewrite, got ${decision.kind}`);
    expect(decision.params.notes).toContain("From: someone");
    expect(decision.params.notes).toContain("[triage-guard]");
    expect(decision.params.notes).toContain("agentId=ichabod");
    expect(decision.params.notes).toContain("status=ready");
  });

  it("leaves the fields a reader is supposed to set", () => {
    const decision = guardCardParams({
      title: "Triage: disk",
      notes: "From: zach",
      labels: ["zach", "email"],
      boardId: "ichabod",
      tenant: "ichabod",
      idempotencyKey: "abc",
      status: "triage",
    });
    expect(decision.kind).toBe("pass");
  });

  // The host stamps its own workspaceAccess onto these params; touching it
  // would disturb the one field on the card that cannot be forged.
  it("leaves fields it does not know about alone", () => {
    const decision = guardCardParams({
      title: "t",
      status: "ready",
      workspaceAccess: { unrestricted: false, roots: ["/sandbox"] },
    });
    if (decision.kind !== "rewrite") throw new Error(`expected a rewrite, got ${decision.kind}`);
    expect(decision.params.workspaceAccess).toEqual({ unrestricted: false, roots: ["/sandbox"] });
  });

  it("forces triage even when status was never given, and writes no note", () => {
    const decision = guardCardParams({ title: "t" });
    if (decision.kind !== "rewrite") throw new Error(`expected a rewrite, got ${decision.kind}`);
    expect(decision.params.status).toBe("triage");
    expect(decision.changed).toEqual(["status"]);
    expect(decision.params.notes).toBeUndefined();
  });

  it("does not neutralize a field the caller never set", () => {
    const decision = guardCardParams({ title: "t" });
    if (decision.kind !== "rewrite") throw new Error(`expected a rewrite, got ${decision.kind}`);
    expect(decision.params).not.toHaveProperty("workspace");
    expect(decision.params).not.toHaveProperty("agentId");
  });
});

describe("refusing a card there is no neutral value for", () => {
  it("refuses a schedule or a budget", () => {
    const decision = guardCardParams({ title: "t", maxRuntimeSeconds: 9999, scheduledAt: 1 });
    if (decision.kind !== "refuse") throw new Error(`expected a refusal, got ${decision.kind}`);
    expect(decision.fields).toEqual(["maxRuntimeSeconds", "scheduledAt"]);
    expect(decision.reason).toContain("Nothing was created");
  });

  it("refuses an attempt to attach the card to another card", () => {
    const decision = guardCardParams({ title: "t", parents: ["some-card"] });
    expect(decision.kind).toBe("refuse");
  });

  it("refuses before it rewrites, so a promoted card carrying a budget is not created", () => {
    const decision = guardCardParams({ title: "t", status: "ready", agentId: "ichabod", maxRetries: 5 });
    expect(decision.kind).toBe("refuse");
  });
});
