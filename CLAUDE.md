# CLAUDE.md

Guidance for Claude Code agents working in this repository.

## Comments

Keep comments sparse: the TypeScript types carry the "what". Write a comment
only for a "why" the code can't show — a workaround, a non-obvious invariant,
or a deliberate deviation from how the rest of the codebase does it — and keep
it to a line or three. Doc comments on files and functions are fine at one
short paragraph. Never narrate what the adjacent code already says.

Exception: JSDoc in `src/dsl.ts` (on `DSLSurface` members, `Table` methods,
and the other editor-facing surfaces) is deliberately verbose —
`scripts/gen-lang-env.js` lifts it into the editor's CodeMirror hover docs, so
its audience is the livecoder, not this repo's reader. Only `/** */` JSDoc is
extracted; `//` comments never reach hover. The tutorial `//` lines inside
`src/samples.ts` program strings are user-facing editor content, not code
comments — keep them verbose too.

## Tests

Tests exist for fast iteration, not exhaustive coverage: a failure should mean
real user-visible breakage, never cosmetic or implementation drift. Test
behavioral contracts (persistence round-trips, sync convergence, replay
determinism, fold/geometry invariants, wire formats, named regressions) — not
implementation details like exact event layouts, display strings, generated
doc text, or tessellation counts, which should be free to change. One
representative test per behavior beats a spread of near-duplicate edge-case
permutations, and assertions should pin only the fields or substrings that are
the actual contract.

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
