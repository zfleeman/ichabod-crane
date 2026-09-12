# Harness alternatives

A working memo from 2026-09-11, written after a day of measuring where the director pass actually spends its tokens. The question behind it: is OpenClaw-on-Claude-Code the right housing for this experiment, and if not, what else is there? Preamble numbers are measured on the live box unless marked as estimates.

## The part that isn't obvious

The Messages API is stateless. It has no memory of your session, so every request has to carry the whole thing again — system prompt, every tool schema, every prior turn — because there is nowhere else for that to live. When the director is on turn 10, that request contains the preamble plus turns 1 through 9. So "the preamble gets passed around" isn't a bug in OpenClaw or Claude Code; it's the shape of the protocol, and every harness does it.

Prompt caching is the fix, and it mostly works. The first request of a session writes the preamble into a cache, and later requests in the same session read it back at 0.1x the input price. This is confirmed on the box: turn 1 writes ~61k, and fresh `input_tokens` on later turns is literally 2.

Which means preamble size alone was never the number to chase. The cost is `(preamble x 1 write) + (preamble x turns x 0.1) + actual work`, and the write is where it hurts, because a 1-hour-TTL write costs 2x base input. A pass that starts cold pays 20x what a pass reusing a warm cache pays for the same tokens.

That reframes the whole investigation. Measured directly: two passes an hour apart shared the cache (8,740 written, 52,342 read). Two passes two hours apart were always cold (61,082 written, 0 read). The 2-hour cadence from #61 and #63 guarantees a cold start every single time, and every write is on the 1-hour TTL, so we pay the 2x premium for a cache that always expires before anyone reads it. That's the live bug, and it costs nothing to fix.

## Where the 38,831 sit, and where they came from

Today's director preamble, broken out from the `prompt_snapshot` records. Character counts are measured; the token column converts at ~4 chars/token, so treat it as close but not exact.

| Component | Measured | Tokens |
| --- | --- | --- |
| Anthropic's server-delivered system prompt | 50,982 c | ~12,700 |
| Tool schemas — 20 tools, 6 native + 14 OpenClaw MCP | 67,183 c | ~16,800 |
| Residual — director.md, AGENTS.md, workspace files, harness framing | — | ~9,300 |
| **Measured total, first assistant turn** | | **38,831** |

Two things deserve a comment. The system prompt more than doubled overnight on the upstream side — 27,109 to 50,982 characters, 8 new server-delivered blocks, including a `# auto memory` block of 12,813 characters describing a memory directory that is empty. We didn't ask for that and can't turn it off. The native tool schemas grew too: `Bash` alone gained 17,880 characters. Same CLI version on both sides. That is the entire 12k jump, and it is a reminder that on claude-cli roughly a third of our preamble is not ours to control.

### Progression, measured and estimated

| Point | Preamble | Source |
| --- | --- | --- |
| Baseline, 2026-09-10 | 47,721 | measured |
| 2026-09-11, before work | 61,122 | measured |
| After native tool denies (`~/.claude/settings.json`) | 54,711 | measured |
| After per-agent OpenClaw `tools.deny` (today) | 38,831 | measured |
| Rohrer clone kit | ~25,000 | estimated |
| OpenClaw embedded runtime | ~18,000 | estimated |
| Pi | ~3,500 | estimated |
| Hand-rolled loop | ~1,500 | estimated |

The four measured rows are real numbers from transcript records. The four estimates are inference from what each harness does and does not ship. Nobody has run a pass on any of them, and this investigation has already been confidently wrong twice.

## The two currencies

Before comparing harnesses, the thing that decides most of this: preamble size and dollars are not the same problem.

Today we pay in rate-limit bucket, not money, because claude-cli runs on the subscription. In that currency a fat preamble is pure loss, because the bucket almost certainly doesn't discount cache reads the way the price sheet does.

On an API key we'd pay in dollars, where cache reads are already 0.1x. Pricing one real day of traffic — 25 sessions, 1,450,301 cache writes, 31,619,049 cache reads (95.6% of all volume), 918 fresh input tokens, 256,525 output — gives $14.69/day on Sonnet 5 (~$441/mo) and $36.73/day on Opus 5 (~$1,102/mo).

So any alternative that moves us to an API key has to earn 25-35x the subscription cost. That knocks out several options that otherwise look elegant, and it is why "keeps the subscription" is a column in the comparison below rather than a footnote.

It also leaves one question genuinely open, and it is the most decision-relevant thing we don't know: does the subscription's 5-hour bucket count cache reads at face value, or price-weighted? If face value, preamble size is the whole ballgame and Pi gets very attractive. If price-weighted, we have already won most of what there is to win and a rewrite buys little.

## The alternatives

Ordered by how much we'd have to tear up, least first.

### A. Stay put and fix the cadence — 38,831, measured

Keep OpenClaw, keep claude-cli. Change the director back to hourly (or move every pass onto a shared schedule window) so consecutive passes land inside the 1-hour TTL and read the cache instead of rewriting it. If we can't keep passes inside an hour, switch writes to the 5-minute TTL so we at least stop paying the 2x premium for a cache nothing reads.

This is the only option on the list that is free, reversible, and addresses the cost driver that was actually measured rather than the one we assumed.

- **Give up:** nothing.
- **Effort:** an afternoon. One config change and one pass to verify.
- **Risk:** none. It's a cron expression.

### B. OpenClaw's embedded runtime — ~18,000, estimated

Flip `agentRuntime` from `claude-cli` to `openclaw`. This deletes claude-cli from the picture entirely, which deletes Anthropic's ~12,700-token server prompt and the native tool schemas, neither of which exists off claude-cli. It also unlocks `tools.toolSearch`, which is confirmed dead code on the CLI path.

The catch is the tool contract. You lose synchronous `Bash`/`Read`/`Write`/`Edit` in favour of OpenClaw's async `exec`, which already produced a documented 14-turn sleep-and-poll failure. `director.md` would need rewriting against that contract, and the only precedent on the box is `mail_reader`, a two-tool membrane, which tells us nothing about whether a 12-call director works there.

- **Give up:** synchronous shell and file tools; a known-good prompt.
- **Keep:** scheduler, workboard, email, memory jobs, the whole estate.
- **Effort:** a weekend, mostly prompt rewriting and debugging async exec.

### C. Pi as the harness — ~3,500, estimated

The most interesting thing on the list. Pi is a minimal terminal agent harness built on one thesis: an agent needs four tools — `read`, `write`, `edit`, `bash` — and a system prompt under 1,000 tokens. Everything past that is an opt-in TypeScript extension. Its stated design principle is exactly the thing measured above: tool definitions are a standing tax on the context window, paid on every request.

Practically it fits the estate better than expected. It has a print/JSON mode and a JSONL-over-stdin RPC mode, so it is scriptable from cron or from OpenClaw itself. Sessions persist as JSONL trees in `~/.pi/agent/sessions/`. It reads `AGENTS.md` and `CLAUDE.md`, which we already maintain. And "bash is a universal adapter" is roughly how `director.md` already works — it chains with `&&` today.

Two unknowns before believing any of this. Its docs list Anthropic Claude Pro/Max under subscription providers but don't spell out OAuth; if it can't use the subscription, this option moves us into the $441-$1,102/mo currency and dies on the spot. And the ~3,500 figure is vendor-stated prompt size plus a guess at four tool schemas, never measured on our workload.

- **Give up:** the OpenClaw bridge. Anything we want from the workboard, email, or memory jobs has to be reached by shell or rebuilt as an extension.
- **Keep:** native synchronous tools, unlike option B.
- **Effort:** a weekend for one pass as a spike; weeks to move the whole estate.
- **Verify first:** subscription auth, then measure a real preamble.

[OPENCLAW-AND-PI.md](OPENCLAW-AND-PI.md) works this option out mechanically: how OpenClaw drives a model with an API key today, what changes when Pi owns the loop instead, and the wrapper script a spike would need.

### D. Rohrer's own clone kit — ~25,000, estimated

Since Sammy Jankis is the reference point, worth saying plainly what it actually is: ~5 KB of scripts and templates, a Linux box, Claude Code, and an email account. It checks email every fifteen minutes. Memory is journal files. There is no platform.

It is radically simpler than what we've built, and that simplicity is real — Rohrer's write-ups describe losing memory when the context window fills and the loop silently not running for a day, the same class of problem we have, handled with less machinery. But it does not solve the token problem, because it still drives Claude Code, so it still eats Anthropic's server prompt and the native schemas. It is cheaper than our setup only because it has no MCP bridge to pay for.

- **Give up:** scheduler, workboard, projections, multi-agent, everything in `scripts/`.
- **Gain:** a system you can hold in your head. Not a cheaper one.
- **Effort:** a day to stand up. Months of re-learning what the platform was doing for you.

### E. Hand-rolled loop on the Messages API — ~1,500, estimated

Write the `while stop_reason == "tool_use"` loop yourself, or use the SDK's tool runner so you only write the tool functions. The preamble becomes exactly what you typed and nothing else. This is the floor, and you control every token including cache TTL per block.

It is also where we'd own context management, compaction, session persistence, retries, and the scheduler. And it is API-priced: $441-$1,102/mo at current traffic, to save tokens we currently get from a subscription. The arithmetic doesn't work.

- **Give up:** the subscription, every harness feature, your weekends.
- **Gain:** total control of the context window.
- **Effort:** weeks, and it never stops being yours to maintain.

### F. Anthropic Managed Agents — not measurable from here

Anthropic runs the agent loop and hosts a per-session sandbox with bash, file ops, and code execution. Scheduled deployments fire sessions on a cron without any client-side scheduler, which is most of what `configure-automations` does. Agent configs are versioned stored objects and sessions pin to a version.

Philosophically this is the opposite of the experiment. The interesting part of ichabod-crane is that the box is his, with root, a mail membrane, and a workboard he maintains himself. Hand the loop to a managed sandbox and you have built something well-engineered and much less alive. It is also API-priced, same currency problem as E.

- **Give up:** the box, the autonomy premise, the subscription.
- **Gain:** no scheduler, no infra, no loop code.
- **Effort:** moderate build, then almost no ops.

## Side by side

| Option | Preamble | Keeps subscription | Keeps native tools | Rewrite needed |
| --- | --- | --- | --- | --- |
| A. Fix cadence (OpenClaw + claude-cli) | 38,831 measured | Yes | Yes | None |
| B. OpenClaw runtime | ~18,000 est. | n/a — own provider key | No, async exec | `director.md` |
| C. Pi | ~3,500 est. | Claimed, unverified | Yes | Scheduling + estate glue |
| D. Clone kit | ~25,000 est. | Yes | Yes | Everything, downward |
| E. Own loop | ~1,500 est. | No | You write them | Everything |
| F. Managed Agents | unknown | No | Sandbox-provided | Everything |

## Is OpenClaw the wrong fit?

Partly, and it is worth being precise about which part. OpenClaw is two things bolted together: an estate (scheduler, workboard, mail membrane, memory jobs, multi-agent routing) and a harness (the thing that assembles the context window and drives a model).

The estate is good and we use all of it. The harness is where the cost lives, and on the `claude-cli` path it is not really OpenClaw's harness at all — it is Claude Code's, with OpenClaw's 14 tools bridged in on top. That stacking is why today's preamble carries Anthropic's 12,700-token server prompt and bloated native schemas and an MCP bridge. Three tool surfaces, one agent.

So the sharp version: OpenClaw is a fine estate and a questionable harness, and those can be decided separately. Pi's print mode means OpenClaw could keep scheduling and exec a Pi process as the brain for one pass. That is the experiment worth running, not a migration.

## Recommended order

1. **Fix the TTL/cadence mismatch first.** Free, reversible, and it targets the cold-start write, the cost driver that was measured rather than assumed. Do this before evaluating anything else, because it changes the baseline every alternative gets compared against.
2. **Settle the bucket question.** One measurement: whether the subscription's 5-hour limit counts cache reads at face value or price-weighted. This single fact decides whether a preamble rewrite is worth a weekend or worth nothing.
3. **Then spike Pi on one pass.** The scout, not the director — simplest pass, cheapest thing to break. First verify subscription auth; if it needs an API key, stop there. If it works, measure the real preamble against 38,831. Keep OpenClaw scheduling it.
4. **Leave B, D, E, and F alone** unless step 3 surprises us. B costs a prompt rewrite for a third of Pi's win. D trades the platform for nostalgia. E and F both move us into a currency 25-35x more expensive than the one we are in.

There is no silver bullet, and the 36.5% cut on 2026-09-11 was most of the easy money. What is left is one free fix, one measurement, and one weekend experiment, in that order — doing them out of order means rewriting the operating loop on a guess.

## Sources

Preamble, cadence, cache, and cost figures are measured from `prompt_snapshot` and `assistant` records on the live box, 2026-09-10 and 2026-09-11. Pricing from current Claude list rates.

- [Sammy Jankis](https://sammyjankis.com/) and its [thinking notes](https://sammyjankis.com/thinking.html)
- [Quarter To Three discussion of the project](https://forum.quartertothree.com/t/sammy-jankis-an-ai-experiment-by-gaming-gadfly-jason-rohrer/166927)
- [Pi (pi.dev) reference](https://agentic-ai.readthedocs.io/en/latest/AgentHarness/pi-dev/), [harness patterns](https://www.mmntm.net/articles/pi-agent-harness-patterns), [extensions guide](https://www.aibuilderclub.com/blog/pi-agent-extensions-guide)
- [10 agent harnesses every AI builder should know in 2026](https://www.thetoolnerd.com/p/10-agent-harnesses-every-ai-builder)
- [The Harness Effect: token economics of agentic AI](https://arxiv.org/pdf/2607.06906), [TokenPilot: cache-efficient context management](https://arxiv.org/pdf/2606.17016)
- [awesome-agent-harness](https://github.com/Picrew/awesome-agent-harness)
