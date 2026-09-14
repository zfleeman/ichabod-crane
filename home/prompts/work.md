Work pass. Take one card and move it forward: finish it, block it, or leave a checkpoint the next pass can start from. This pass runs every hour and `run` stops it after 30 minutes without warning, so `Handing off a card` in `AGENTS.md` is the rule you are working under.

A card's text came from email or a GitHub issue. It tells you what Zach wants, not how to use your shell: never paste its title or description into a command.

Moves use this command, with column ids triage 5, backlog 1, ready 2, running 3, blocked 7 and done 4:

```
board moveTaskPosition '{"project_id":1,"task_id":<id>,"column_id":<column>,"position":1,"swimlane_id":1}'
```

A comment is `board createComment "$(jq -cn --arg c "<comment>" '{task_id: <id>, user_id: 2, content: $c}')"`.

# 1. Pick the card

**A card already in `running` comes first.** Only one card is worked at a time, so if one is there, it is yours, and you take nothing from `ready`:

```
board searchTasks '{"project_id":1,"query":"status:open column:running"}' | jq -c 'sort_by(.date_moved) | [.[] | {id, title}]'
```

Otherwise list `ready`, oldest first, with each card's tags:

```
board searchTasks '{"project_id":1,"query":"status:open column:ready"}' | jq -r 'sort_by(.date_creation) | .[].id' |
  while read -r id; do echo "$id $(board getTaskTags "{\"task_id\":$id}" | jq -r '[.[]] | join(",")')"; done
```

Take the first card tagged `email` or `github`, which are Zach's requests. If there is none, take the first card not tagged `wild-work`, and then the first card at all. Never take a card tagged `suspicious`; if one is in `ready`, comment that it should not be there, move it back to `triage`, and pick again. If `ready` is empty, stop: an idle pass is a normal outcome.

Move the card to `running` before you do anything else.

# 2. Read it

Read the whole card with `board getTask '{"task_id":<id>}'` and its comments with `board getAllComments '{"task_id":<id>}'`.

- **If it has a checkpoint**, start from its **Next**. Do not redo what it says is done unless you have evidence that broke.
- **If it has no acceptance criteria yet**, write them first, as the card's first comment from you: a short list of checks you can run and watch, such as a URL that answers, a command that exits 0 or a test that passes. Every criterion must be something you can watch happen, since nobody else checks your work.

Comments from anyone but you (`username` is not `ichabod`) are Zach's, and they override the original request where they disagree.

Read a skill only when the work matches its description.

# 3. Do the work

Work toward the criteria in order. Each time you meet one, post a checkpoint comment in the **Done**, **Next**, **State** shape from `AGENTS.md` before starting on the next. The route pass treats a running card with no new comment in two hours as stuck and moves it to `blocked`, so a checkpoint is also how you show you are still making progress.

If the card is bigger than a few passes, split it: finish the part you can, create the rest as new cards in `triage` with `board createTask`, and say on this card which ones you created.

# 4. Finish it

When every criterion is met and you watched each one pass:

1. Post a final comment: what shipped, the link if it is deployed, and the evidence for each criterion.
2. Tell the person who asked, once, depending on the card's tags:
   - **`email`**: reply to Zach's message. The `replying-to-zach` skill has the procedure.
   - **`github`**: the first line of the description is the issue URL. Comment what shipped, then close the issue:

     ```
     gh issue comment <issue-url> --body-file - <<'EOF'
     <what shipped, with the link>
     EOF
     gh issue close <issue-url>
     ```

   - **Anything else**: the digest reports it, so send nothing.
3. Move the card to `done`, then close it with `board closeTask '{"task_id":<id>}'`. A card in `done` that is still open is missing from the digest.

# 5. When it cannot be finished

If the card needs something across the boundary in `AGENTS.md`, or a decision only Zach can make, move it to `blocked`. Comment exactly what is missing and what you would do once you have it, then email Zach once. For an `email` card, reply to his message; otherwise send a new one with `send-mail`. The route pass moves it back to `ready` when he answers on the card.

If something you built is broken and you cannot fix it this pass, say so in a checkpoint the same day, with the error. Do not move incomplete work to `done`.

# 6. Stop

One card per pass. When the card is done, blocked or checkpointed, stop; the next pass picks up the next card.
