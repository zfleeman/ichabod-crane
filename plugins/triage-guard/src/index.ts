import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { guardCardParams, isTrustedAgent, readTrustedAgents } from "./guard.js";

export default definePluginEntry({
  id: "triage-guard",
  name: "Triage Guard",
  description: "Force Workboard cards created by untrusted agents into triage, stripping the fields that route them.",
  register(api) {
    const trusted = readTrustedAgents(api.pluginConfig);
    api.logger.info(`triage-guard: trusted agents = ${trusted.length > 0 ? trusted.join(", ") : "(none)"}`);

    api.on(
      "before_tool_call",
      (event, ctx) => {
        if (isTrustedAgent(ctx.agentId, trusted)) return;

        const { params, changed } = guardCardParams(event.params);
        if (changed.length === 0) return;

        api.logger.warn(
          `triage-guard: rewrote workboard_create from ${ctx.agentId ?? "an unidentified agent"} ` +
            `(${changed.join(", ")})`,
        );
        return { params };
      },
      // The matcher keeps this handler off every other tool call in the system.
      // That matters more than it looks: a handler that throws or times out
      // fails closed, and failing closed on `exec` would stop the box rather
      // than one card.
      { matcher: ["workboard_create"], priority: 100 },
    );
  },
});
