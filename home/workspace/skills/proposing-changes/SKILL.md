---
name: proposing-changes
description: Use when creating a repository on the ich4bod account, or when proposing any change to zfleeman/ichabod-crane by pull request.
user-invocable: false
---

# Source control, and proposing changes to your own toolset

Source belongs on the `ich4bod` GitHub account. Create repositories freely, private by default, and name and commit to them however you think best.

## Every new repository gets Zach as a collaborator

Do this as part of creating the repository, not as a follow-up you might forget:

```
gh api -X PUT repos/ich4bod/<repo>/collaborators/zfleeman
```

He reads your work and files issues from his own account rather than logging into yours, and the scout pass sweeps those issues onto the board. A repository he cannot see is one he cannot ask you about.

Two things about that call. It sends an invitation, which sits pending until he accepts — `gh api repos/ich4bod/<repo>/invitations` lists the ones still outstanding, and a pending invitation is not access. And on a personal-account repository **every collaborator has write access**: granular roles are an organization feature, so `-f permission=pull` returns 204 and silently changes nothing. Do not add `permission=pull` and record that you granted read-only, because you did not. If you ever need a genuinely read-only reader, the repository has to be public or live in an organization.

Never push to a repository on Zach's account. The single exception is proposing changes to `zfleeman/ichabod-crane`, and it works by fork, so it is not really an exception at all. You may propose a change to anything in that repository: skills, prompts, scripts, the crontab, docs, and `tofu/`.

## Opening the pull request

Your checkout is `/home/ichabod/src/ichabod-crane`, where `origin` is your fork `ich4bod/ichabod-crane` and `upstream` is `zfleeman/ichabod-crane`.

1. Fetch `upstream`.
2. Branch from an up-to-date `upstream/main`.
3. Push the branch to `origin`.
4. `gh pr create --repo zfleeman/ichabod-crane`.

You hold read access on `upstream` and nothing more, so a direct push to it fails with a permission error. That is the boundary working, not a broken setup — do not try to route around it.

Keep a pull request to one subject, and write the body for Zach: what is wrong now, what the change makes true instead, and how you found it. He is the only reviewer, so an unclear pull request just costs him time. Note on the card, or in the digest, that you opened it.

## Two ways this looks like success and is not

**A merged pull request does not change your behavior.** `home/workspace/AGENTS.md` reaches this box only when Zach deploys from his laptop. Between merge and deploy, the repository and your live workspace disagree, and the workspace copy is the one governing you.

**`home/workspace/USER.md` and `home/workspace/MEMORY.md` in that repository are first-boot seeds, not your live files.** The deploy writes them once and never again, so a pull request editing them would be reviewed, merged, and change nothing. Those two you edit in place, here.

The same split applies to skills. Everything in `skills/` is Zach's: it arrives read-only and is replaced on every deploy, so propose changes to it by pull request. Skills you write go in `own-skills/`, which is yours to edit in place and which a deploy never touches. When one of your own skills would serve better as a shipped one, propose it by pull request into `home/workspace/skills/`.
