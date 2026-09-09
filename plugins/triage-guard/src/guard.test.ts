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

describe("card guarding", () => {
  it("forces a promoted card back to triage", () => {
    const { params, changed } = guardCardParams({
      title: "Triage: something",
      status: "ready",
      agentId: "ichabod",
      priority: "urgent",
    });
    expect(params.status).toBe("triage");
    expect(params).not.toHaveProperty("agentId");
    expect(params).not.toHaveProperty("priority");
    expect(changed).toEqual(expect.arrayContaining(["agentId", "priority", "status"]));
  });

  it("strips a chosen workspace", () => {
    const { params } = guardCardParams({
      title: "t",
      workspace: { kind: "dir", path: "/home/openclaw" },
      maxRuntimeSeconds: 9999,
      parents: ["other-card"],
    });
    expect(params).not.toHaveProperty("workspace");
    expect(params).not.toHaveProperty("maxRuntimeSeconds");
    expect(params).not.toHaveProperty("parents");
  });

  it("records what arrived in the notes", () => {
    const { params } = guardCardParams({ title: "t", notes: "From: someone", status: "ready", agentId: "ichabod" });
    expect(params.notes).toContain("From: someone");
    expect(params.notes).toContain("[triage-guard]");
    expect(params.notes).toContain("agentId=ichabod");
    expect(params.notes).toContain("status=ready");
  });

  it("leaves the fields a reader is supposed to set", () => {
    const { params } = guardCardParams({
      title: "Triage: disk",
      notes: "From: zach",
      labels: ["zach", "email"],
      boardId: "ichabod",
      tenant: "ichabod",
      idempotencyKey: "abc",
      status: "triage",
    });
    expect(params).toEqual({
      title: "Triage: disk",
      notes: "From: zach",
      labels: ["zach", "email"],
      boardId: "ichabod",
      tenant: "ichabod",
      idempotencyKey: "abc",
      status: "triage",
    });
  });

  it("reports no change for a card that arrived clean", () => {
    const { changed } = guardCardParams({ title: "t", status: "triage" });
    expect(changed).toEqual([]);
  });

  // The host stamps its own workspaceAccess onto these params; removing it
  // would strip the one field on the card that cannot be forged.
  it("leaves fields it does not know about alone", () => {
    const { params } = guardCardParams({
      title: "t",
      status: "triage",
      workspaceAccess: { unrestricted: false, roots: ["/sandbox"] },
    });
    expect(params.workspaceAccess).toEqual({ unrestricted: false, roots: ["/sandbox"] });
  });

  it("sets triage even when status was never given", () => {
    const { params, changed } = guardCardParams({ title: "t" });
    expect(params.status).toBe("triage");
    expect(changed).toEqual(["status"]);
    expect(params.notes).toBeUndefined();
  });
});
