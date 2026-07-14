# Plan: branching edits derived from session history

Goal: the user scrubs back in the session history, makes some changes, and ends
up on a *new branch* instead of (as today) being snapped back to the head. The
old branch stays intact and reachable through a custom GUI. Everything is
derived by folding the apply history: each event has an id, each apply
references its parent apply event, and each apply lists the edit events it
applies — an apply action *is* applying a series of edits.

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
   `log[0..at]` — it's the set of events R's ancestry *explicitly claims*,
   folded in `(seq, src)` order.
2. **"Runs are a linear list."** Runs become a tree; the session bar scrubs the
   path from the root to the current branch head.

## Data model

### The apply node: a commit of an explicit changeset

Make the apply bookmark itself a first-class event (it mostly already is — the
`'apply'` record on the activity table), carrying identity, ancestry, and the
edits it applies:

```
{ kind: 'apply', table: 'activity',
  id: 'a<random>',          // stable id, minted at append time
  parent: 'a…' | null,      // the apply this one builds on; null for the first
  edits: ['<src>#<seq>', …],// ids of the edit events this apply commits,
                            // in (seq, src) order
  mode: 'extend' | 'fork',  // extend = append my edits to the shared line;
                            // fork = deliberately branch from a past apply
  ... existing fields (changed, at) }
```

Edit events are identified by their existing `(src, seq)` key (`eventKey` in
`event-log.ts`) — no new field needed on them for *membership*. The apply's own
id is minted (same recipe as `localSource()`): sturdier across migrations than
reusing its stamp, and what `parent` refs point at.

Crucially, `recordRun()` and the `'apply'` activity record merge into one
event: the apply event **is** the run. `SessionRun`/the saved `runs` list stays
only as a legacy input (see Compatibility); at runtime the run structure is a
fold of apply events.

This makes branch membership **explicit rather than inferred**. Divergence
needs no marker event: scrub back to apply₁ and edit, and those edits are
simply *unclaimed* until the next apply (parent = apply₁, mode `fork`) claims
them, while the old branch's applies claim their own. The motivating ambiguity
— two lines of history both "following" apply₁, indistinguishable by seq
ranges because forked edits append at the log tail — never arises, because no
fold ever asks "which edits follow this node"; it reads each apply's list.

`mode` makes forking a recorded **intent, not a race outcome**: an apply made
at what the replica believes is the tip records `extend` — it is "appending a
series of edits" to the shared line — and only an apply made from a
scrubbed/checked-out position records `fork`. Concurrency alone never creates
a branch (see Multiplayer); only deliberately editing history does.

Size note: an apply listing a few hundred cell edits costs a few KB of ids.
Fine as-is; if a pathological session ever cares, `edits` compacts losslessly
to per-src seq ranges without changing the model.

### The open working tail: one lightweight stamp

`edits` lists cover *committed* history. Un-applied edits — accumulated since
the last apply — belong to no apply yet, but three things must still locate
them:

1. **The live fold**: your pending edits must show in the current state.
2. **Reload mid-edit**: the session persists on every change (`persistSession`
   fires on store change), so pending edits must reattach to the right branch
   when the session is reopened.
3. **Multiplayer**: peers see each other's cell edits *before* apply today
   (merge refolds everything); that must survive.

"Unclaimed and newer than the head apply" is not a safe rule: edits from an
*abandoned* fork (scrub back, edit, check out away without ever applying) stay
unclaimed forever and would wrongly overlay every later head.

So edit events also carry `base: <node id>` — the apply the replica was
extending when it authored the edit. It is deliberately **not** the membership
authority (the apply's `edits` list is); it is a working-tail hint that
answers exactly one question: *which node are these pending, unclaimed edits
extending?* The live fold overlays unclaimed edits with `base = head` on the
head's committed fold; reload and peers recover the same answer from the same
stamp. Abandoned-fork edits keep their `base` pointing at the node they forked
from, so they never contaminate other branches — they're simply invisible
everywhere, which is correct: they were never applied.

### The fold

Add a pure module (`src/branches.ts`, mirroring the style of `event-log.ts`):

```ts
interface ApplyNode { id: string; parent: string | null; edits: string[]; mode: 'extend' | 'fork'; seq: number; src: string }
interface BranchTree {
  nodes: Map<string, ApplyNode>
  children: Map<string, string[]>       // parent id -> child ids, (seq,src)-ordered
  heads: string[]                       // leaf apply ids = the branches
  pathTo(id: string): ApplyNode[]       // root..id — the session bar's scrub axis
}
buildBranchTree(events: StampedEvent[]): BranchTree
branchEvents(events: StampedEvent[], head: string | null, tree: BranchTree): StampedEvent[]
```

`branchEvents` selects: the applies on `pathTo(head)` interleaved with the
events their `edits` lists claim (dereferenced by `(src, seq)` key), plus —
for the *live* head only — unclaimed events with `base = head`, all in
`compareEvents` order. Scrubbing to a mid-branch apply is the same call with
the truncated path and no pending overlay: truncation falls out for free, no
seq-window reasoning anywhere.

Events predating the first apply need no special case: the first apply claims
them in its `edits` like anything else.

**Linearization of concurrent extends**: after linking nodes by `parent`,
`buildBranchTree` rewrites each node's `extend`-mode children into a chain in
`(seq, src)` order — the first stays a child, each next one is re-parented
onto the previous — while `fork`-mode children remain true siblings. This is
how a genuine race (two replicas applied at tip X before seeing each other)
resolves: both recorded parent X and mode `extend`, and every replica folds
them into the *same single line*, so peers stay on one branch. It's a pure
function of the log — no reconciliation event, no "who noticed first"
protocol.

Defensive rules, same spirit as `applyEvent`: an apply whose `parent` is
unknown (partial/merged log) parents to the root; a missing `mode` is read as
`extend` (a lone child chains trivially, so this is also the legacy-friendly
default); a cycle (corrupt data) breaks at the repeated node; an `edits` id
that dereferences to nothing is skipped; an event claimed by two applies on
one path (racing extends may both claim shared pending edits they'd each
seen) folds once, at its `(seq, src)` position.

## Store changes (`editable-tables.ts`)

The store gains a notion of *current node* and *pending edits*, and its fold
becomes branch-aware:

- Internal state: `head: string | null` (the apply whose branch the live fold
  shows; null = fresh/legacy log) and `pending: string[]` (ids of edits
  appended since `head`, i.e. the working tail — recoverable from `base`
  stamps, kept materialized for cheap appends).
- `append()` stamps `base: head` on every ordinary event and pushes its key
  onto `pending`. The incremental head-fold keeps working because, on the
  current branch, new events always extend the current fold.
- `recordApply(payload)` replaces `recordRun()`: appends the apply event with
  `{ id, parent, edits: pending, mode }`, then sets `head = id`,
  `pending = []`. Returns the node. `mode` is `fork` only when the apply comes
  from a scrubbed/checked-out node; otherwise `extend` — and for an `extend`,
  `parent` **fast-forwards to the current tip** of the branch, not the stale
  base: if merged peer applies landed since this replica's last apply, the new
  apply parents the newest of them, and the replica's pending edits (typically
  non-conflicting — other tables, other rows) simply ride along in `edits` and
  fold after the peer's. `runs()`/`setRuns()`/`SessionRun` survive only for
  session-format compatibility.
- **Fork-on-edit** — the behavioral heart of the feature. Replace the
  `append() → replay = null` rule: if a mutation arrives while a replay view is
  active (scrubbed to apply N), set `head = N`, discard `pending` (edits based
  on the old head stay in the log, unclaimed and inert), promote the replay
  fold to be the live `tables` fold, clear `replay`, and land the edit there
  with `base = N`. The user's edit hits the state they were *looking at*;
  nothing is rewritten — the old branch's applies still claim their events and
  its head remains a leaf in the tree.
- `checkout(headId)`: set `head = headId`, `pending` = unclaimed events with
  `base = headId` (normally none; picks up a working tail left by a reload or
  a peer), refold `tables = foldEventsMap(branchEvents(log.all(), headId,
  tree))`, notify. "Getting back to the old branch" is just checkout;
  continuing it is just applying with that parent.
- `setReplayView(nodeId | null)` changes coordinate: from a prefix `SessionRun`
  to an apply id on the current branch path (fold = truncated `branchEvents`).
- `branchTree()`: expose the fold (cached, invalidated by `onChange`) for the
  GUI.
- `onMerge` refold: rebuild the tree, keep `head` if it still exists, else fall
  back to newest apply; recompute `pending` from `base` stamps.

## `main.ts` changes

- `evaluate()`: when invoked while scrubbed (session bar not at latest), do
  **not** `setReplayView(null)`-back-to-head first — cook against the scrubbed
  fold and let `recordApply` create the `fork`-mode child of the scrubbed
  apply. (The cook itself may append ensure()/retainDeclared events; they land
  as pending with the right `base` and are claimed by this apply — the
  fork-on-edit rule makes the first such append perform the fork.) When at
  latest, behavior is unchanged: an `extend` apply, fast-forwarded onto
  whatever the branch tip is by `recordApply`.
- `scrubSession(pos)`: `pos` indexes `tree.pathTo(head)` instead of the flat
  runs list; latest position = live head fold (committed + pending), as today.
- Edit-while-scrubbed needs no main.ts code: the store's fork-on-edit covers
  inline table edits, and the subsequent Ctrl-Enter apply commits the branch.
- `clearRuns()` keeps its meaning by scoping: the CLEAR_RUNS_KIND marker hides
  applies at-or-before it on the current path from the scrub bar (tree fold
  skips them), same spirit as today.

## GUI

Session bar (`ui/session-bar.tsx`) additions, keeping the humble-object split:

1. Scrubber semantics: unchanged look; `count` = current branch path length.
2. **Branch indicator + switcher**: when the tree has >1 leaf, show a chip
   ("branch 2/3" or a name) that opens a small popover listing branch heads —
   labeled by time, run count, and a short diff hint (first changed line of
   `code` vs. the fork point's, derivable from the folds). Clicking one calls
   `checkout(headId)`; the bar re-targets that path and jumps to its tip.
3. **Fork affordance while scrubbed**: when the thumb sits on an apply with
   children (i.e. an edit/apply here will fork), tint the bar differently and
   label it ("editing here starts a new branch") so branching is visible before
   it happens, not after.
4. Optional (later): a mini tree/graph popover — nodes per apply, one column
   per branch — for sessions where the dropdown list stops being enough.
5. Branch naming: a `{ kind: 'name-branch', head, name }` activity event; pure
   fold, trivially multiplayer-safe. Nice-to-have, not phase 1.

## Persistence & compatibility

- The saved session format (`sessions.ts`) doesn't change shape: `events` is
  still the whole serialized log (applies' `edits`/`parent` and edits' `base`
  are just event fields), `runs` is still written for old builds to read. Add
  `head` (current branch) to the record — like `runs`, a convenience,
  re-derivable as "newest apply" if absent. Pending edits need nothing extra:
  they're in the log with `base` stamps.
- Loading a **legacy linear session** needs no migration for correctness: no
  applies carry `edits`, so the tree is empty → the store falls back to
  `deriveRunsFromCode()`-style linear runs, exactly today's behavior. The
  first new apply claims the whole existing log as its `edits` (one big
  initial commit), after which branching works forward. Alternatively an
  `EventMigration` in `EDITABLE_MIGRATIONS` stamps legacy logs into one
  explicit branch (walk linearly; each `'apply'` gets `id` + `parent` =
  previous apply + `edits` = the events since it; ordinary events get `base`)
  — do this if the fallback dual-path in the scrub code turns out messier than
  the migration. The migration is the cleaner end state; the chain exists
  precisely for this.
- `deriveRunsFromCode()` remains the fallback for sessions with neither stamped
  applies nor a saved runs list.

## Multiplayer

Nothing new to sync: applies and stamps are ordinary events, `mergeEvents` and
the (seq, src) order already make the tree deterministic on every replica.
Semantics to settle (deliberately kept simple):

- **Which branch do peers watch?** Keep the current rule generalized: the
  performance head is the newest apply event (by seq, src) on *any* branch —
  an apply on a fork moves everyone there, exactly like an apply does today. A
  peer who has locally checked out another branch is in the same state as a
  peer scrubbed back today (their next edit forks). If explicit shared
  checkout is wanted later, it's one more activity event kind.
- **Peers' un-applied edits** stay visible exactly as today: they merge in
  unclaimed with `base = head`, and the live fold overlays them.
- **Concurrent applies append; they don't fork.** The goal: non-conflicting
  concurrent work (edits on separate tables, separate parts of the code) lands
  on the *same* branch, and peers stay together. Three layers deliver it:
  1. *Intent on the event* (`mode`): only a deliberate apply-from-history
     records `fork`; a tip apply records `extend` — "append my series of edits
     to the shared line".
  2. *Apply-time fast-forward*: a replica whose tip moved underneath it (peer
     applies merged in since its base) parents its `extend` apply onto the
     current tip. Its claimed edits fold after the peer's — for disjoint
     tables/cells that's exactly the intended union.
  3. *Fold-time linearization* (see The fold): the leftover true race — both
     applied at X before seeing each other, so both recorded parent X — chains
     `extend` siblings deterministically into one line on every replica.
- **Conflict is advisory, not structural.** Two `extend` applies that touch
  the *same* cell still linearize — which is precisely today's last-write-wins
  multiplayer semantics, so the degenerate case degrades to exactly current
  behavior instead of silently splitting the performance. Content-conflict
  detection becomes a GUI concern (badge the apply: "overwrote N's edit —
  branch instead?"), not a fold concern. The one genuinely shared cell — the
  program text in `code[0].code` — can do better at *apply time* (polish
  phase): 3-way merge the text (base's code, mine, theirs); a clean merge
  extends with the merged program, a dirty one surfaces the choice to fork.
  The fold stays dumb either way.

## Testing

Extend `test/editable-tables.test.ts` / add `test/branches.test.ts`, pure-fold
style like the existing tests:

- Tree fold: linear log → single path; fork → two heads; fork-of-fork; unknown
  parent; dangling `edits` id; cycle guard; CLEAR_RUNS interaction.
- Membership: the motivating case — apply₁ → edits → apply₂, scrub to apply₁,
  edit, apply₃ — assert apply₂'s branch folds exactly its claimed edits and
  apply₃'s exactly its own, with the shared prefix in both.
- Working tail: pending edits overlay only their `base` head; abandoned-fork
  edits (scrubbed, edited, checked out away, never applied) appear on no
  branch; reload mid-edit reattaches pending to the right branch.
- Fork-on-edit: mutation while scrubbed lands on the scrubbed state, head
  branch untouched; checkout of a leaf continues it (next apply parents it).
- Round-trips: serialize/load preserves the tree; legacy (unstamped) session
  loads to linear behavior; first apply on a legacy log claims it wholesale;
  migration (if adopted) produces the same folds the live session had.
- Merge: two logs forked from a common prefix merge into the same tree on both
  replicas; a peer's unclaimed edits show at head.
- Concurrency: an `extend` apply fast-forwards onto a merged-in tip (disjoint
  table edits from both replicas all present in the folded state); racing
  `extend` applies with the same parent linearize identically on both
  replicas, including when both claim shared pending edits (folded once); a
  `fork`-mode apply racing an `extend` keeps its own branch; same-cell racing
  extends resolve last-write-wins, matching today's behavior.

## Phasing

1. **Foundations (pure):** `branches.ts` fold + tests, including extend-chain
   linearization; the apply event shape (`id`/`parent`/`edits`/`mode`) and
   `base` stamping + `recordApply` (with fast-forward) in the store (still
   linear behavior — every apply extends the tip and claims the pending
   edits). Ship: no visible change.
2. **Fork-on-edit + checkout:** store fork rule (`fork`-mode applies),
   branch-aware replay/fold, `evaluate`/`scrubSession` rewiring. Ship:
   branching works, GUI still shows only the current path.
3. **GUI:** branch chip + switcher popover, fork-warning tint, `head` in the
   session record. Ship: the feature as described.
4. **Polish:** branch naming, mini-graph, conflict badges on concurrent
   extends, apply-time 3-way merge of the code text, legacy-log migration if
   the dual path warrants it, shared-checkout event if multiplayer use asks
   for it.
