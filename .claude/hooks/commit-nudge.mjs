#!/usr/bin/env node
// PreToolUse(Bash) nudge: when a `git commit` is about to run, inject a short
// reminder of the CLAUDE.md guidelines next to the tool call. Non-blocking —
// emits `additionalContext` with no permission decision, so the commit still
// runs through the normal flow. Silent for every other Bash command.
import { readFileSync } from 'node:fs';

let command = '';
try {
  command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '';
} catch {
  process.exit(0); // unreadable/non-JSON stdin: stay out of the way
}

if (!/\bgit\s+commit\b/.test(command)) process.exit(0);

const reminder = [
  'CLAUDE.md guideline reminder before committing:',
  '- Keep the codebase small: prefer the simpler solution, fit new features into existing abstractions instead of adding new functions/modules/concepts, fold refactoring into the change, and delete code the change makes dead.',
  '- Comments: only for a "why" the code cannot show (a workaround, a non-obvious invariant, a deliberate deviation); keep them sparse and never narrate what the code already says. Intentional exceptions: verbose JSDoc in src/dsl.ts and the tutorial // lines in src/samples.ts.',
  '- Tests: pin behavioral contracts (persistence round-trips, sync convergence, replay determinism, wire formats, named regressions) — not implementation details like exact event layouts, display strings, or tessellation counts.',
  '- Branch: commit to the designated feature branch. If that branch\'s PR is already merged, start fresh from the default branch instead of stacking new commits on merged history.',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reminder },
}));
