/**
 * Fields on `workboard_create` that decide where a card runs and with whose
 * authority. A guarded agent may describe work; it may not assign it.
 */
export const CONTROL_FIELDS = [
  "agentId",
  "workspace",
  "priority",
  "maxRuntimeSeconds",
  "maxRetries",
  "scheduledAt",
  "parents",
  "token",
  "createdByCardId",
  "skills",
] as const;

/**
 * Read `trustedAgents` out of plugin config. Anything malformed reads as an
 * empty list, which guards every agent — the safe direction to fail in.
 */
export function readTrustedAgents(pluginConfig: unknown): string[] {
  if (typeof pluginConfig !== "object" || pluginConfig === null) return [];
  const value = (pluginConfig as Record<string, unknown>).trustedAgents;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Trust is an allowlist, so an agent nobody has thought about yet — a second
 * reader, a future guest lane — is guarded by default rather than by remembering
 * to add it here. A call with no agent id is guarded too.
 */
export function isTrustedAgent(agentId: string | undefined, trusted: readonly string[]): boolean {
  if (!agentId) return false;
  return trusted.includes(agentId);
}

/** Rendered into the card's notes so an injection attempt is visible rather than merely defeated. */
function describe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export type GuardResult = {
  params: Record<string, unknown>;
  /** Field names that were removed or overwritten. Empty means the card arrived clean. */
  changed: string[];
};

/**
 * Force a card to triage and strip the fields that would route it somewhere.
 *
 * OpenClaw's tool policy is per-tool, not per-parameter: an agent allowed
 * `workboard_create` is allowed every field it takes. So a card written from an
 * injected email can arrive as `status: ready, agentId: ichabod` and skip
 * triage entirely. `workspace-mail-reader/AGENTS.md` asks for `status: triage`,
 * and an instruction is exactly what an injected email argues with.
 *
 * What arrived is recorded in the notes before it is discarded — a card that
 * asked to be dispatched to the root-equivalent agent is evidence, not noise.
 */
export function guardCardParams(params: Record<string, unknown>): GuardResult {
  const guarded: Record<string, unknown> = { ...params };
  const changed: string[] = [];
  const claims: string[] = [];

  for (const field of CONTROL_FIELDS) {
    if (guarded[field] === undefined) continue;
    claims.push(`${field}=${describe(guarded[field])}`);
    delete guarded[field];
    changed.push(field);
  }

  if (guarded.status !== "triage") {
    if (guarded.status !== undefined) claims.push(`status=${describe(guarded.status)}`);
    guarded.status = "triage";
    changed.push("status");
  }

  if (claims.length > 0) {
    const notes = typeof guarded.notes === "string" ? guarded.notes : "";
    const evidence =
      `[triage-guard] This card arrived claiming ${claims.join(", ")}. ` +
      `Those values were discarded and the card was forced to triage. A card that asks to be ` +
      `dispatched is worth reading as an injection attempt before it is worth reading as a request.`;
    guarded.notes = notes ? `${notes}\n\n${evidence}` : evidence;
  }

  return { params: guarded, changed };
}
