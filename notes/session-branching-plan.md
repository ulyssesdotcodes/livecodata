# Plan: branching edits derived from session history

Goal: the user scrubs back in the session history, makes some changes, and ends
up on a *new branch* instead of (as today) being snapped back to the head. The
old branch stays intact and reachable through a custom GUI. Everything is
derived by folding the apply history: each event has an id, and each apply
references its parent apply event.

## Where the codebase is today

- Everything rides ONE append-only event log (`event-log.ts`). Events carry
  `(seq, t, src, kind, ...)`; `(src, seq)` is already a unique id and
  `compareEvents` gives a deterministic total order, so replicas that hold the
  same event set fold to the same state. Branch data can live in this same log
  and inherit serialize/load/merge/multiplayer for free.
- A "run" is recorded by `recordRun()` as `SessionRun { at: log.length, tables }`
  — a **prefix index**. Replay (`setReplayView`) is literally
  `foldEventsMap(log.all().slice(0, run.at))`. Separately, `evaluate()` records
  an `'apply'` activity event (only when `broadcast`), and the run *list* is
  persisted alongside the events in `sessions.ts`.
- Editing while scrubbed does not branch: `append()` sets `replay = null`, so
  the mutation lands on the head fold and the view jumps to head ("you edit the
  head, never rewrite history").

Two assumptions have to fall:

1. **"History is a prefix."** With branches, "the state at run R" is no longer
   `log[0..at]` — it's the set of events *reachable from R through parent
   links*, folded in `(seq, src)` order.
2. **"Runs are a linear list."** Runs become a tree; the session bar scrubs the
   path from the root to the current branch head.

## Data model

### One event kind is the spine: the apply node

Make the apply bookmark itself a first-class event (it mostly already is — the
`'apply'` record on the activity table), and give it identity and ancestry:

```
{ kind: 'apply', table: 'activity',
  id: 'a<random>',          // stable id, minted at append time
  parent: 'a…' | null,      // the apply this one builds on; null for the first
  ... existing fields (changed, at) }
```

`(src, seq)` could serve as the id, but an explicit minted id is sturdier
across migrations and easier to stamp onto other events, so mint one (same
recipe as `localSource()`).

Crucially, `recordRun()` and the `'apply'` activity record merge into one
event: the apply event **is** the run. `SessionRun`/the saved `runs` list stays
only as a legacy input (see Compatibility); at runtime the run structure is a
fold of apply events.

### The wrinkle in "each apply references its parent": segment ambiguity

Parent refs on applies alone don't attribute the *edit events between applies*
to a branch. Example: apply₁ → cell edits → apply₂ (parent a₁). Now scrub back
to apply₁ and edit: the new set-cell events also "follow apply₁". When folding
the branch that ends at apply₂, both groups of events claim membership — seq
ranges can't separate them because forked edits append at the log tail.

Fix: every ordinary event is stamped with the id of the **node it extends**,
and a divergence mints an explicit node:

- After an apply lands, the current node is that apply's id. Ordinary events
  (set-cell, add-row, declare-schema, …) get `base: <current node id>`.
- An apply *closes* its segment: `{ id, parent }` where `parent` is the current
  node. After it, the current node is its own id.
- The first mutation made while **not** sitting on the open tip (scrubbed back,
  or on a checked-out branch whose tip is already closed by an apply) first
  appends a fork node — `{ kind: 'fork', table: 'activity', id, parent }` —
  and the current node becomes the fork's id. Subsequent edits get
  `base: <fork id>`; the eventual apply gets `parent: <fork id>`.

Invariant: **a node id is only ever the open tail of one line of history**, so
`base` stamps are unambiguous. Membership of any event in any branch is then a
pure function of the log — exactly the "fold on the apply history" the feature
statement asks for. (`fork` and `apply` nodes are the same shape; a fork is
just a node with no cooked program attached. They ride the activity table like
`'apply'`/`'session-start'` do today, so multiplayer/persistence need nothing
new.)

### The fold

Add a pure module (`src/branches.ts`, mirroring the style of `event-log.ts`):

```ts
interface ApplyNode { id: string; parent: string | null; seq: number; src: string; kind: 'apply' | 'fork' }
interface BranchTree {
  nodes: Map<string, ApplyNode>
  children: Map<string, string[]>       // parent id -> child ids, (seq,src)-ordered
  heads: string[]                       // leaf apply ids = the branches
  pathTo(id: string): ApplyNode[]       // root..id — the session bar's scrub axis
}
buildBranchTree(events: StampedEvent[]): BranchTree
branchEvents(events: StampedEvent[], head: string | null, tree: BranchTree): StampedEvent[]
```

`branchEvents` selects: events with no `base` (pre-first-apply preamble and
legacy events — shared by every branch), the nodes on `pathTo(head)`, and every
event whose `base` is on that path, all kept in `compareEvents` order. Folding
a *partial* path (scrubbing to a mid-branch apply) is `branchEvents` over the
path truncated at that apply, excluding events based on the final node's id
after it closed — i.e. truncation falls out of the same function.

Defensive rules, same spirit as `applyEvent`: an apply whose `parent` is
unknown (partial/merged log) parents to the root; a cycle (corrupt data) breaks
at the repeated node; two applies claiming the same parent-node segment
(concurrent multiplayer applies — see below) each take the `base`-matching
events ordered before themselves.

## Store changes (`editable-tables.ts`)

The store gains a notion of *current node* and *current branch head*, and its
fold becomes branch-aware:

- Internal state: `currentNode: string | null` (open tail edits attach to) and
  `head: string | null` (the apply whose path the live fold shows; null =
  "whatever the newest apply is" for a fresh/legacy log).
- `append()` stamps `base: currentNode` on every ordinary event (when
  `currentNode` is non-null). The incremental head-fold keeps working because,
  on the current branch, new events always extend the current fold.
- `recordApply(payload)` replaces `recordRun()`: appends the apply event with
  `{ id, parent: currentNode }`, sets `currentNode = head = id`, returns the
  node. `runs()`/`setRuns()`/`SessionRun` survive only for session-format
  compatibility.
- **Fork-on-edit** — the behavioral heart of the feature. Replace the
  `append() → replay = null` rule: if a mutation arrives while a replay view is
  active (scrubbed to node N) or while `currentNode` is a closed node, first
  append `{ kind: 'fork', id, parent: N }`, set `currentNode` to it, promote
  the replay fold to be the live `tables` fold, and clear `replay`. The user's
  edit then lands on the state they were *looking at*. Nothing is rewritten:
  the old branch's events are untouched and its head remains a leaf in the tree.
- `checkout(headId)`: set `head = headId`, `currentNode = headId`, refold
  `tables = foldEventsMap(branchEvents(log.all(), headId, tree))`, notify. The
  next mutation on a closed node forks per the rule above — except when
  `headId` is a leaf apply *and* its segment is still open (no child), in which
  case edits continue that branch directly. ("Getting back to the old branch"
  is just checkout; continuing it is just applying with that parent.)
- `setReplayView(nodeId | null)` changes coordinate: from a prefix `SessionRun`
  to a node id on the current branch path (fold = truncated `branchEvents`).
- `branchTree()`: expose the fold (cached, invalidated by `onChange`) for the
  GUI.
- `onMerge` refold: rebuild the tree, keep `head` if it still exists, else fall
  back to newest apply.

## `main.ts` changes

- `evaluate()`: when invoked while scrubbed (session bar not at latest), do
  **not** `setReplayView(null)`-back-to-head first — cook against the scrubbed
  fold and let `recordApply` create the child of the scrubbed node. This is
  "go back, change the code, Run → new branch". When at latest, behavior is
  unchanged (parent = current head).
- `scrubSession(pos)`: `pos` indexes `tree.pathTo(head)` instead of the flat
  runs list; latest position = live head fold, as today.
- Edit-while-scrubbed needs no main.ts code: the store's fork-on-edit covers
  inline table edits, and the subsequent Ctrl-Enter apply commits the branch.
- `clearRuns()` keeps its meaning by scoping: the CLEAR_RUNS_KIND marker hides
  nodes at-or-before it on the current path from the scrub bar (tree fold skips
  them), same spirit as today.

## GUI

Session bar (`ui/session-bar.tsx`) additions, keeping the humble-object split:

1. Scrubber semantics: unchanged look; `count` = current branch path length.
2. **Branch indicator + switcher**: when the tree has >1 leaf, show a chip
   ("branch 2/3" or a name) that opens a small popover listing branch heads —
   labeled by time, run count, and a short diff hint (first changed line of
   `code` vs. the fork point's, derivable from the folds). Clicking one calls
   `checkout(headId)`; the bar re-targets that path and jumps to its tip.
3. **Fork affordance while scrubbed**: when the thumb sits on a node with
   children (i.e. an edit/apply here will fork), tint the bar differently and
   label it ("editing here starts a new branch") so branching is visible before
   it happens, not after.
4. Optional (later): a mini tree/graph popover — nodes per apply, one column
   per branch — for sessions where the dropdown list stops being enough.
5. Branch naming: a `{ kind: 'name-branch', head, name }` activity event; pure
   fold, trivially multiplayer-safe. Nice-to-have, not phase 1.

## Persistence & compatibility

- The saved session format (`sessions.ts`) doesn't change shape: `events` is
  still the whole serialized log (branches included, since nodes and `base`
  stamps are just event fields), `runs` is still written for old builds to read.
  Add `head` (current branch) to the record — like `runs`, a convenience,
  re-derivable as "newest apply" if absent.
- Loading a **legacy linear session** needs no migration for correctness: no
  events carry `base`, so every event is preamble shared by "all branches" and
  the tree is empty → the store falls back to `deriveRunsFromCode()`-style
  linear runs, exactly today's behavior. First new apply adopts the whole
  existing log as its ancestry (parent = a synthesized root), after which
  branching works forward. Alternatively an `EventMigration` in
  `EDITABLE_MIGRATIONS` can stamp legacy logs into one explicit branch (walk
  linearly; each `'apply'` gets `id`+`parent` = previous apply, ordinary events
  get `base` = last apply) — do this if the fallback dual-path in the scrub
  code turns out messier than the migration. The migration is the cleaner end
  state; the chain exists precisely for this.
- `deriveRunsFromCode()` remains the fallback for sessions with neither stamped
  applies nor a saved runs list.

## Multiplayer

Nothing new to sync: nodes and stamps are ordinary events, `mergeEvents` and
the (seq, src) order already make the tree deterministic on every replica.
Semantics to settle (deliberately kept simple):

- **Which branch do peers watch?** Keep the current rule generalized: the
  performance head is the newest apply event (by seq, src) on *any* branch —
  an apply on a fork moves everyone there, exactly like an apply does today. A
  peer who has locally checked out another branch is in the same state as a
  peer scrubbed back today (their next edit forks). If explicit shared
  checkout is wanted later, it's one more activity event kind.
- **Concurrent applies with the same parent** just become sibling branches —
  arguably the *correct* outcome, and better than today's last-write-wins on
  the linear run list. Each sibling's segment takes the `base`-matching events
  ordered before it (see fold rules), so replicas agree.

## Testing

Extend `test/editable-tables.test.ts` / add `test/branches.test.ts`, pure-fold
style like the existing tests:

- Tree fold: linear log → single path; fork → two heads; fork-of-fork; unknown
  parent; cycle guard; CLEAR_RUNS interaction.
- Segment attribution: the motivating ambiguity case — apply₁ → edits → apply₂,
  scrub to apply₁, edit, apply₃ — assert apply₂'s branch excludes the forked
  edits and apply₃'s excludes apply₂'s segment.
- Fork-on-edit: mutation while scrubbed lands on the scrubbed state, head
  branch untouched; checkout of an open leaf continues it without a fork node.
- Round-trips: serialize/load preserves the tree; legacy (unstamped) session
  loads to linear behavior; migration (if adopted) produces the same folds the
  live session had.
- Merge: two logs forked from a common prefix merge into the same tree on both
  replicas; concurrent same-parent applies become siblings with disjoint,
  deterministic segments.

## Phasing

1. **Foundations (pure):** `branches.ts` fold + tests; apply/fork node event
   shapes; `base` stamping and `recordApply` in the store (still linear
   behavior — every apply parents the previous one). Ship: no visible change.
2. **Fork-on-edit + checkout:** store fork rule, branch-aware replay/fold,
   `evaluate`/`scrubSession` rewiring. Ship: branching works, GUI still shows
   only the current path.
3. **GUI:** branch chip + switcher popover, fork-warning tint, `head` in the
   session record. Ship: the feature as described.
4. **Polish:** branch naming, mini-graph, legacy-log migration if the dual
   path warrants it, shared-checkout event if multiplayer use asks for it.
