# CLAUDE.md

Guidance for Claude Code agents working in this repository.

## Follow-up work after opening a PR

Before starting follow-up work on a branch that already has an open pull
request, check whether that pull request has been merged (or closed).

- If it's still open, keep developing on the existing branch and pushing to
  the existing PR as usual.
- If it has been merged (or closed), do not push new commits onto that
  branch/PR — it's finished and can't track new work. Instead:
  1. Fetch the latest default branch (e.g. `git fetch origin main`).
  2. Create a new branch off of the default branch for the new work.
  3. Push the new branch and open a new pull request for it.
