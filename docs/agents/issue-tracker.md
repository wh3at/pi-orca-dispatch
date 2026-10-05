# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `wh3at/pi-orca-dispatch`.
Use the `gh` CLI. Infer the repository from the Git remote.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Apply/remove labels: `gh issue edit <number> --add-label "..." --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Use appropriate state and label filters when listing issues.
Use a heredoc or body file for multiline text.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue with comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares issue and PR numbers. Resolve an ambiguous number with
`gh pr view <number>`, falling back to `gh issue view <number>`.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, with Notes, Decisions-so-far,
  and Fog in its body.
- Child tickets: link as GitHub sub-issues. If unavailable, use a task list
  in the map and `Part of #<map>` in each child body.
- Ticket labels: `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Blocking: use native GitHub issue dependencies. Add a blocker with
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Obtain the database ID with
  `gh api repos/<owner>/<repo>/issues/<blocker> --jq .id`.
  If dependencies are unavailable, use `Blocked by: #<number>` in the child body.
- Frontier: among open map children, choose the first in map order with
  no assignee and no open blockers. Native dependencies expose open
  blockers through `issue_dependencies_summary.blocked_by`.
- Claim: `gh issue edit <number> --add-assignee @me` as the session's first write.
- Resolve: comment with the answer, close the ticket, then append a
  context pointer (gist and link) to the map's Decisions-so-far.
