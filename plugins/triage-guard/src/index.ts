import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { guardCardParams, isTrustedAgent, readTrustedAgents } from "./guard.js";

export default definePluginEntry({
  id: "triage-guard",
  name: "Triage Guard",
  description: "Force Workboard cards created by untrusted agents into triage, neutralizing the fields that route them.",
  register(api) {
    const trusted = readTrustedAgents(api.pluginConfig);
    api.logger.info(`triage-guard: trusted agents = ${trusted.length > 0 ? trusted.join(", ") : "(none)"}`);

    api.on(
      "before_tool_call",
      (event, ctx) => {
        if (isTrustedAgent(ctx.agentId, trusted)) return;
        const agent = ctx.agentId ?? "an unidentified agent";

        const decision = guardCardParams(event.params);
        if (decision.kind === "pass") return;

        if (decision.kind === "refuse") {
          api.logger.warn(`triage-guard: refused workboard_create from ${agent} (${decision.fields.join(", ")})`);
          return { block: true, blockReason: decision.reason };
        }

        api.logger.warn(`triage-guard: rewrote workboard_create from ${agent} (${decision.changed.join(", ")})`);
        return { params: decision.params };
      },
      // The matcher keeps this handler off every other tool call in the system.
      // That matters more than it looks: a handler that throws or times out
      // fails closed, and failing closed on `exec` would stop the box rather
      // than one card.
      { matcher: ["workboard_create"], priority: 100 },
    );
  },
});
