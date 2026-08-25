# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `wxxb789/ghc-proxy`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,state,labels,assignees,comments,url --jq '{number, title, body, state, labels: [.labels[].name], assignees: [.assignees[].login], comments: [.comments[] | {author: .author.login, body}], url}'`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --json number,title,body,state,labels,author,comments,url --jq '{number, title, body, state, labels: [.labels[].name], author: .author.login, comments: [.comments[] | {author: .author.login, body}], url}'`, plus `gh pr diff <number>` for the diff. When triage needs the relationship, read it with `gh api repos/{owner}/{repo}/pulls/<number> --jq .author_association`; the installed `gh pr --json` field set does not expose it.
- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open&per_page=100' --jq '.[] | select(.author_association == "CONTRIBUTOR" or .author_association == "FIRST_TIME_CONTRIBUTOR" or .author_association == "NONE") | {number, title, body, labels: [.labels[].name], author: .user.login, authorAssociation: .author_association}'`. Read comments only for selected PRs with the command above.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be
either. Resolve with `gh pr view 42 --json number --jq .number` and fall back to
`gh issue view 42 --json number --jq .number`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run the structured `gh issue view ... --json ... --jq ...` command above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

The `wayfinder:*` names below are a desired contract, not evidence that the
labels are installed. Before first use, inspect the current tracker:

```bash
gh label list --limit 200 --json name --jq '.[].name'
```

Create missing labels only after explicit authorization and a fresh inventory.

Until a label exists, omit `--label wayfinder:*` and preserve the role in the
issue title/body. Do not silently substitute unrelated labels.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. After the label exists, create it with `gh issue create --label wayfinder:map`; otherwise omit the label and record the role in the body.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. After provisioning, use `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`); otherwise record the type in the body. Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
