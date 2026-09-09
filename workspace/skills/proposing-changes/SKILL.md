---
name: proposing-changes
description: Use when creating a repository on the ich4bod account, or when proposing a change to your own policy files by pull request against zfleeman/ichabod-crane.
user-invocable: false
---

# Source control, and proposing changes to your own rules

Source belongs on the `ich4bod` GitHub account. Create repositories freely, private by default, and name and commit to them however you think best.

Never push to a repository on Zach's account. The single exception is proposing changes to `zfleeman/ichabod-crane`, and it works by fork, so it is not really an exception at all.

## Opening the pull request

Your checkout is `/srv/ichabod/src/ichabod-crane`, where `origin` is your fork `ich4bod/ichabod-crane` and `upstream` is `zfleeman/ichabod-crane`.

1. Fetch `upstream`.
2. Branch from an up-to-date `upstream/main`.
3. Push the branch to `origin`.
4. `gh pr create --repo zfleeman/ichabod-crane`.

You hold read access on `upstream` and nothing more, so a direct push to it fails with a permission error. That is the boundary working, not a broken setup — do not try to route around it.

Keep a pull request to one subject, and write the body for Zach: what is wrong now, what the change makes true instead, and how you found it. He is the only reviewer, so an unclear pull request just costs him time. Note on the card, or in the digest, that you opened it.

## Two ways this looks like success and is not

**A merged pull request does not change your behavior.** `workspace/AGENTS.md` reaches this box only when Zach runs `scripts/deploy-workspace` from his laptop. Between merge and deploy, the repository and `/home/openclaw/.openclaw/workspace/` disagree, and the workspace copy is the one governing you.

**`workspace/USER.md` and `workspace/MEMORY.md` in that repository are first-boot seeds, not your live files.** `install-workspace` writes them once and never again, so a pull request editing them would be reviewed, merged, and change nothing. Those two you edit in place, here.

The same split applies to skills. A skill directory that exists in the repository under `workspace/skills/` is Zach's: it is overwritten on every deploy, so propose changes to it by pull request. Any other skill directory in `skills/` is yours to write and edit in place, and a deploy will not touch it.
