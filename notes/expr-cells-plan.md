# Plan: math in Expr, expr-valued table cells, and a mobile expr editor

Goal: any numeric attribute of the scene ("three") table and any post-table
variable (`set`/`pulse` `value` cells) can hold a live math expression instead
of a literal — editable from the table panel with a touch-first GUI, syncing
and replaying like every other cell. Expressions gain real math (sin, min,
clamp, lerp, …) and a `progress()` source that reads the enclosing event's
percent-done (0→1 across its duration).

Everything builds on machinery that already exists: the serializable Expr AST
(`src/dsl.ts`), the `{ $expr: node }` binding markers playback resolves per
frame via `resolveBindings`, and the event-sourced cell store that already
round-trips arbitrary JSON cell values through persistence, multiplayer, and
the cook worker verbatim. The work is (1) growing the AST, (2) making every
consumer of the affected cells binding-aware, (3) a new cell editor.

---

## 1. Math in the Expr AST

### 1.1 One generic call node + a function registry

Add a single node kind rather than one kind per function:

```ts
| { k: 'call'; fn: string; args: ExprNode[] }
```

with a registry that is the single source of truth (the `POST_OPS` idiom):

```ts
export const EXPR_FNS: Record<string, { arity: number; apply: (...ns: number[]) => number; doc: string }>
```

Contents: `sin cos tan asin acos atan atan2 abs floor ceil round sqrt exp log
sign pow min max clamp lerp fract wrap` — all pure and deterministic (no
`Math.random`, no wall clock; determinism is what makes replay/scrub exact).
`clamp(x, lo, hi)`, `lerp(a, b, t)`, `wrap(x, lo, hi)`. Constants `pi`/`tau`/`e`
are namespace sugar over `lit`.

The registry feeds four consumers: `evalExpr`, the node validator (1.3), the
GUI palette (4), and the editor docs (5) — add a function once, it appears
everywhere.

### 1.2 Surface and switches

- Chainable methods for unary/self-first forms: `field("beat").mul(0.5).sin()`,
  `.abs()`, `.floor()`, `.clamp(lo, hi)`, `.pow(e)` …
- Namespace forms for multi-arg: `expr.min(a, b)`, `expr.lerp(a, b, t)`,
  `expr.sin(x)`, plus `expr.pi` / `expr.tau`.
- Both exhaustive switches learn the node (`dsl.ts`):
  - `isStreamingNode`: `case 'call': return n.args.some(isStreamingNode)` —
    critical, or `sin(slider("x"))` bakes to a constant instead of deferring.
  - `evalExpr`: look up `EXPR_FNS[n.fn]`, `Number()`-coerce evaluated args,
    apply.
- **Runtime default without losing the compile check**: cells are wire format,
  so older clients will meet node kinds they don't know; both switches need a
  runtime default (evaluate to 0 / not-streaming) — but a bare `default` arm
  would destroy `isStreamingNode`'s TS2366 exhaustiveness error (its only
  compile-time safety net; `evalExpr` returns `unknown` and never had one).
  Use a never-assert default in both:
  `default: { const _x: never = n; void _x; return false }` — a forgotten case
  on the closed union stays a compile error while unknown wire nodes (outside
  the type) hit the default at runtime.
- JSDoc every new method/namespace member — `gen-lang-env.js` lifts it into
  hover/completions on rebuild (see 5).
- Node-shape guard: a call node's key set is `{k, fn, args}` — it can never
  collide with cook-transfer's single-key `{ $fn: string }` rehydration check;
  keep that invariant for any future node kind.

### 1.3 Node validator

New `validateExprNode(n): boolean` (recursive: closed kind set, known `fn`,
correct arity, children valid). Used by `cellValid` (2.3), the GUI before
commit, and as the version-skew gate: an event from a newer peer carrying an
unknown node kind renders the cell invalid-red instead of NaN-ing the render
(eval still degrades to 0 via the default arm).

### 1.4 `progress()` — percent-done of the enclosing event

New streaming node `{ k: 'progress' }`, surfaced as `expr.progress()`. It
resolves to 0→1 across the duration of the event (row) the expression lives
on, so `set` rows can shape their own tween (`expr.progress().mul(tau).sin()`)
and scene keyframes can shape their own segment.

Implementation is **substitution at fold/bake time, not a new EvalCtx member**:
every place that knows both the row's window and the current frame builds a
per-frame clone of the node path down to each `progress` node, replacing it
with `{ k: 'lit', v: u }` — **never mutating the source node**: the nodes live
inside memoized rows (`materialize`'s memo reuses row arrays by hash, and
`gatherExtra` copies by reference), so an in-place rewrite would freeze the
first-computed u into the memo across re-cooks and sibling frames. Keeping
`resolveBindings`/EvalCtx untouched also keeps this deterministic under scrub
(u is a pure function of frame):

- **post** (`post.ts` foldVars): `u = clamp01((frame - row.index) / durFrames)`
  — the same u the tween already computes. `set` without `dur` → 1; `pulse`
  requires `dur` already. foldVars runs per playback frame, so this is a
  per-frame clone+eval — cheap, but not free; the numeric-only fast path must
  skip it entirely.
- **scene** (`rasterize.ts` sampleObject): baked rows are per-frame, so while
  carrying an expr value onto baked frame `i`, substitute u for that frame.
  The window, in order: the row's own `dur` if set (new semantics — `dur` on
  transform keyframes currently plays no role, only color pulses read it);
  else from the row's frame to the **next keyframe carrying this field** (the
  per-field segment the expr actually spans — "next keyframe of the object"
  would plateau progress at 1 mid-carry whenever keyframes of other fields
  interleave); else to the object's destroy frame or the bake extent (the
  extent lives only in `rasterizeRows` today and must be threaded into
  `sampleObject`/`gatherExtra` as a parameter). Clamp 0..1. Substitution on
  this path happens once at cook, so playback cost is zero; note the fidelity
  ceiling: baked u is frozen per cache frame (FRAMES_PER_BEAT = 30 grid) while
  `time()`-driven exprs stay continuous per render frame — document, don't
  fight it.
- After substitution, if no other streaming node remains the expression is
  evaluated right there and lands as a plain number.

`isStreamingNode('progress') = true` so derive-time baking defers it. An
unsubstituted `progress` reaching `evalExpr` (a table with no duration
concept) evaluates to 1, the graceful degrade.

This subsumes the `phase()` idea in `notes/dsl-live-coding-plan.md` C2 for
events; a loop-phase source can still come later as its own node.

### 1.5 `field()` in vars cells — same substitution

`resolveBindings` for post/hydra variables passes the **vars map** as the row
(`visualizer.ts:155,237`), so `field("beat")` in a post `value` cell would read
a sibling *variable*, not the table row — a trap the GUI would otherwise walk
straight into. Give `field` the same fold-time treatment as `progress`: the
fold has the real row in hand, so substitute `field` nodes with
`lit(row[name])` there (post `foldVars`, hydra's setVariable fold at
`hydra.ts:131-133`). On the scene path `field()` naturally reads the baked
row — no change. Result: `field()` means "this row's columns" everywhere,
which is what the palette will say it means.

---

## 2. Expr-valued cells: storage, wire, and every consumer

### 2.1 Storage form: always the plain marker

Cells hold `{ $expr: node }` — never `Expr` class instances. Recon confirmed
the marker already survives every hop verbatim: the set-cell fold stores
values untouched (`editable-tables.ts:478`), `conformRow` keeps present values,
protocol/multiplayer/session persistence are unvalidated JSON, structured
clone and `packValue`/`unpackValue` recurse it unchanged, and `stableStringify`
hashes it deterministically so an expr edit invalidates the cook memo
correctly.

**Fix required — seeding from code is silently broken today**: `editable(name,
schema, seedRows)` with `Expr` instances in seeds crosses the worker boundary
by structured clone, which never calls `toJSON`, leaving a dead `{ node: … }`
object (`cook-service.ts:78`, `cook-worker.ts:19`). Normalize seed rows (and
any row values) to `{ $expr }` markers with a small walk (`Expr` →
`expr.toJSON()`) in `dsl.editable()` / cook-service before they're recorded.
Test this — the failure is invisible (cells look populated, never resolve).

### 2.2 Eligibility: a per-column schema flag + per-event row rules

Eligibility cannot key on table names — `cellValid(value, col)` never sees
one, tables get renamed, and samples reuse schemas under other names
(`editable("hydra sketch", schemas.hydra)`). And some rules are finer than a
column: post `set`/`pulse` share the `value` column with `layer` in one table.
Two layers:

- **Column-level**: `ColumnSpec`/`EditableColumn` gain `expr?: true`, stamped
  in the SCHEMAS declarations. It rides declare-schema events, mergeColumns,
  serialization, and the cook worker for free, and `cellValid` reads
  `col.expr` with no signature change. Flagged: scene-table object attributes
  (`px/py/pz`, `rx/ry/rz`, `sx/sy/sz`, `color`, light/camera numerics —
  `intensity`, `fov`, `tx/ty/tz`, …), post `value`, hydra `value`. Not
  flagged: `beat`/`dur`/`end`/`loop`/`ease`/`id`/`type`/`shape` (exprs there
  NaN rasterize's frame math, drop rows from the timeline strip, corrupt sort
  order — all silently); bauble `value` (every change recompiles the shader —
  a streaming expr would recompile per frame); particles `value` (sim params
  filter `typeof number`); geometry dims (`hx/hy/hz/r/h`, text `size`) at
  first — a streaming expr there would dispose+rebuild BufferGeometry every
  frame.
- **Row-level** (in `invalidColumns`, which already receives the whole row):
  hydra `replace` rows must reject expr `value` — the fold splices
  `String(row.value)` into the sketch code, so a marker becomes the literal
  text `[object Object]` inside the program (`hydra.ts:142-144`); scene rows
  with `color` + `dur` reject expr color (the pulse path bit-ops the value).
  Post `layer` needs no rule: `amountExpr` already degrades an object to the
  `'0.5'` default harmlessly. Audit every other event sharing a flagged
  column the same way.

### 2.3 Cross-cutting cell plumbing

- **`cellValid`** (`editable-tables.ts:97`): a value passing `isBinding` +
  `validateExprNode` is valid in an expr-flagged `number` column; malformed
  markers stay invalid. Also **tighten the string/code arm** to reject
  binding objects — today `default: return true` accepts any object in a
  string column, which would silently admit exprs into `id`/`name`/`find`.
  Both changes relax/tighten pinned contracts — update
  `test/editable-tables.test.ts` deliberately. (`cellValid` is main-thread
  UI-only; of this module only `conformRow`/`schemaColumns` ship in the
  worker bundle.)
- **Display**: new pure module `src/expr-text.ts` — `formatExpr(node)` →
  compact formula (`slider("height") * 2 + sin(time)`). Wire it into
  `formatEditableCell`/`formatCell` (`table-panel.ts:75-97`) so cells, the
  timeline-strip readouts, events sub-tabs, and hover cards all render
  formulas instead of `''` / `[object Object]` / raw JSON. (Its inverse,
  `parseExpr`, ships with the GUI's text mode in phase 4 — it has no earlier
  consumer.)
- **Cell editor safety gate (correctness, not polish)**: `EditableCell`
  dispatches on value shape *before* the per-type editors — there is no undo,
  and today one tap on an expr cell in a number column opens
  `Number(raw()) || 0` and permanently commits `0` to every peer on blur
  (`ui/table-panel.tsx:662-667`). An `isBinding` value renders as a formula
  chip. Until the sheet ships (phase 4) the chip is inert **plus a
  "revert to number" affordance** (commit the expr's last-known/0 literal) so
  a seeded or peer-synced expr is never a dead end; Tab/advanceEdit skip expr
  cells in that interim.
- **Graphs**: `drawSeriesChart` currently bridges expr rows with a straight
  segment; mark non-numeric points (gap or hollow marker) so charts don't
  fabricate data. Low priority.

### 2.4 Scene ("three") table path

Recon's sharpest finding: there is **no editable scene schema today** — every
sample's "three" is a computed view — and rasterize silently drops or clobbers
non-numeric update-keyframe fields. Work:

1. **`schemas.scene`** (new SCHEMAS entry + docs + a sample): `{ beat, id,
   type: ['create','update','destroy'], shape: [...], px..pz, rx..rz, sx..sz,
   color, dur, ease: ['linear','easeIn','easeOut','easeInOut'], disabled }`.
   Rasterize gains post-style `easingOf(string)` resolution (`EASINGS` lookup)
   — today it only honors function-valued `ease`, which JSON cells can never
   hold, so editable keyframes currently always play linear. That fix stands
   alone even without exprs.
2. **rasterize** (`rasterize.ts`) — expr keyframes join the per-field track
   scan itself; a bolt-on carry pass is not enough, because the track write is
   the **last** writer into the baked row and would clobber the expr:
   - Binding-valued keys join the `names` collection (`:105`) and the
     prev/next scan (`:113`) as first-class keyframe values. Lerp only when
     both prev and next are numbers; otherwise hold prev (with the per-frame
     progress-substituted clone when prev is a binding). An expr keyframe
     thereby *terminates* numeric segments — today the scan skips non-numeric
     keyframes, so a numeric track would lerp straight *through* the expr's
     span. Numeric↔expr transitions therefore **step**; gliding is expressed
     *inside* the expr via `progress()`/`time()` — the livecoding-native
     answer. (A later enhancement can resolve both endpoints per frame and
     lerp.)
   - This applies to **every tracked field name, not just RESERVED ones**:
     light/camera numerics (`intensity`, `fov`, `tx/ty/tz`, …) are
     non-reserved, ride `gatherExtra` *and* the track loop — today an expr
     update there isn't dropped but actively overwritten by the numeric track
     (prev = create's literal, next = none → reset every frame). The
     track-scan fix covers them because the loop is already name-generic; the
     progress window for purely-extra fields (no keyframe segment) follows
     1.4's per-field rule.
   - `color`: expr allowed as step only; the `dur` pulse path runs bit-ops
     (`mixColor`) that would garbage an object — the 2.2 row rule forbids it.
   - Pinned tests: create `px:0` @f0 / update `px:{expr}` @f10 / update `px:5`
     @f20 → frames 10–19 sample the expr (not a 0→5 glide); same shape for a
     non-reserved light `intensity`; string `ease` resolves.
3. **three-scene** (`three-scene.ts`): today an unresolved/NaN value makes the
   mesh vanish with no error (`px as number` into `Vector3`). Sweep the
   transform paths to guarded numerics (`numOr(v, default)`) so a bad expr
   degrades to the default pose instead of disappearing — the GUI's error
   surface is the invalid-cell flag, not a vanished object.
4. Treat nodes as immutable everywhere (the GUI builds new nodes; nothing
   mutates in place — see 1.4's memo-poisoning rationale).

### 2.5 Post variables path

`foldVars` (`post.ts:162-220`) currently: tween guard requires numeric
prev+target (expr degrades to a step), a non-numeric base silently **drops
pulses**, and pulse values coerce to 0. Rework using composite nodes — the
fold *constructs* bindings instead of needing an EvalCtx:

- **Tween with expr endpoint(s)**: emit
  `{ $expr: {k:'call', fn:'lerp', args:[prevNode, targetNode, lit(easedU)]} }`
  — u and the ease are already known per frame at fold time; endpoints
  (lit-wrapped numbers or expr nodes) resolve per frame at the visualizer's
  existing `resolveBindings(frame.vars, ctx)` (`visualizer.ts:237`).
- **Pulses over any base**: when base or a pulse value is an expr, emit
  nested `{k:'bin', op:'add'}` / `{k:'bin', op:'mul'}` nodes (`add`/`mul` are
  bin ops, not registry functions): `add(baseNode, mul(pulseNode, lit(env)))`.
- Numeric-only rows keep the current arithmetic fast paths byte-for-byte, so
  the pinned tween/pulse tests pass unchanged.
- `progress` and `field` substitution per 1.4/1.5 happen here too.
- The cook/replay callers (`post-scene.ts:330`, `replay.ts:51`) run foldVars
  ctx-free — composite bindings keep that total (nothing evaluates at fold
  time), and `stateId` is untouched (set/pulse values never enter the chain
  signature, so exprs can never force a recompile).
- `val()`-derived rows: the dirty flag already protects a user's expr edit
  from re-derivation clobbering (`editable-tables.ts:307`); `postVarDecls`'
  numeric-literal regex stays as-is (a `val("x", <expr>)` in code declares
  nothing — out of scope).
- Two clocks caveat to document: expr `time()` is `srcFrameF/FPS` (source
  position) while a chain's `p.time` is pass-adjusted — same as today's
  derive() semantics.

### 2.6 Slider declarations from cell exprs

`expr.slider()` in *code* declares its slider through the cook; a slider node
inserted into a *cell* by the GUI has no declaration path, so the control
would never appear. Two-part fix: the GUI calls `store.defineSlider(id)` when
a slider token is inserted (instant, offline-capable), and the cook
additionally walks editable-cell expr nodes for `slider` kinds when reporting
`DeclaredSlider`s (belt-and-braces for hand-written / synced cells).

### 2.7 Apply semantics

Cell edits are pending until Run/Apply — playback reads the last cook's baked
snapshot, so an expr edit is invisible until re-cook. Adopt the code-cell
precedent (`main.ts:140-143`): the expr editor's commit = `store.setCell` +
`evaluate(liveCode, { seed: liveSeed })`. Mid-gesture values never touch the
store (see 4); one commit per edit, like the timeline strip. Two inherited
semantics to state deliberately (they match the code-cell and strip
precedents): a commit is a **full Apply** — it flushes *every* pending table
edit into the run, not just this cell — and it re-runs the last-*applied*
program, so a dirty (typed-but-unrun) editor buffer stays dirty.

---

## 3. Wire format & compatibility

- `{ $expr: node }` becomes wire format the moment it ships: multiplayer
  merges and session loads are unvalidated JSON, and every replica/version
  must agree on it forever. The validator + never-assert default arms (1.2,
  1.3) are the compat story: old clients render newer nodes as 0 +
  invalid-red; they never NaN or crash.
- `isBinding` fires on *any* object with an `$expr` key — resolution paths
  gain nothing new to fear (they already meet these objects from `derive()`),
  but the validator runs at the cell boundary so garbage can't masquerade.
- Keep every node kind's key set distinct from `{ $fn: string }` (cook
  transfer) and never introduce a row column named `$lineage`.

---

## 4. The mobile GUI: a bottom-sheet expression editor

**Recommendation: a structured token editor in a bottom sheet ("expr sheet"),
with drag-to-scrub literals and a text mode for power users.** Not CodeMirror:
the one editor pane is desktop-shaped and collapsed on mobile, JS completions
are overkill for one expression, and typing `expr.field("v").add(1)` on a
phone keyboard is hostile. A token editor writes the AST directly — no parse
errors, no invalid intermediate states, fat-finger friendly.

### 4.1 Interaction design

- **In the cell**: expr cells render as a compact formula chip
  (`formatExpr`, ≥24 px hit target — the strip's touch floor). Tap opens the
  sheet. A number cell's editor gains a small `ƒx` affordance converting the
  literal into an expression (seeding the sheet with `lit(current)`); the
  button must `preventDefault` on pointerdown/mousedown — the number editor
  commits on blur, so an unguarded button first fires a permanent synced
  set-cell of the literal and unmounts the editor before its click lands
  (the text editor documents this exact hazard at `ui/table-panel.tsx:685`).
- **Geometry**: the sheet occupies the **side-panels region** (its top edge
  at the canvas-pane boundary, ≈43% of a mobile viewport) — *not* "the lower
  half": the playback controls + timeline strip float at the bottom of the
  canvas pane (`style.css:1643`, absolute, bottom 20px) and must stay visible
  and tappable. Give the sheet an explicit z-index tier above the settings
  popovers (20/30) and reposition the text-mode input with `visualViewport`
  when the soft keyboard opens (nothing in the app handles it today). Canvas
  visibility above the sheet is *context*, not live feedback — see the
  readout below and 2.7's apply semantics; cheap mid-gesture canvas preview
  (patching the edited cell's resolved value into the live visualizer's rows,
  bypassing the cook) is phase-5 material.
- **Open/close state**: the sheet is keyed off the existing `editingCell`
  signal with its DOM nested inside the cell's `td` — that buys grid-key
  suppression, the tab-switch reset, and the outside-mousedown dismissal
  chain (`ui/table-panel.tsx:112-118`) for free. Outside taps: if the AST
  changed, confirm before discarding (an accidental canvas tap must not eat a
  built-up expression — outside-click semantics today are cancel-without-
  commit); unchanged → plain dismiss. Escape/back behave like the code-cell
  editor. Tab at an expr cell opens the sheet (phase 4; skipped in phases
  2–3).
- **Expression row**: the AST linearized as tappable token chips
  (`slider("height")` `×` `2` `+` `sin(` `time` `)`), selected token
  highlighted. Tapping an operator/function in the palette wraps or replaces
  the selection; a delete chip unwraps. The AST is the model — every state is
  a valid expression. Long expressions **wrap** to multiple chip lines rather
  than scrolling horizontally — a scrolling row would fight `touch-action:
  none` on scrub-able tokens (axis-arbitration is possible but wrap is
  simpler and reads better).
- **Literal scrubbing**: number tokens drag horizontally to scrub (pointer
  capture + movement threshold, the timeline-strip pattern); vertical distance
  switches coarse/fine like DAW controls. Preview-locally, commit-once: the
  gesture updates only local state and the **live value readout**. Node
  identity stays stable during the drag (the slider panel's documented mobile
  invariant).
- **Live value readout** — the expression evaluated each frame at the
  playhead so you watch the number the cell would produce. Plumbing that does
  not exist yet: the ctx pieces are module-local closures inside `main.ts`'s
  playbackOptions and the engine assembles its EvalCtx privately per tick
  (`playback.ts:344-348`) — add a `getEvalCtxAt(srcFrame)` accessor to the
  playback API (or export a pure ctx-assembly helper), wire it through
  `TablePanelOptions`/`PanelProps` (`playIndex` + `beatToFrame` supply the
  frame). Honest approximations, stated in the UI's favor: for post/hydra
  value cells the readout evaluates `field()` against the row (matching 1.5's
  substitution semantics) and shows `progress()` symbolically as `u` (its
  value is fold-time, window-dependent); scene cells evaluate against the
  store's keyframe row, not the baked row.
- **Palette**: two rows of large targets. Sources: `123` (literal), `slider ▾`
  (existing ids from the sliders table, or new — triggers `defineSlider`,
  2.6), `midi ▾`, `time`, `progress`, `field ▾` (the row's columns — the 1.5
  substitution is what makes this label true for vars cells), `beat`. Ops:
  `+ − × ÷ %`, `sin cos abs floor`, `min max clamp lerp pow`, and a `more…`
  overflow fed by `EXPR_FNS` — the registry drives the palette, so new
  functions appear without GUI edits.
- **Commit**: Apply = one `set-cell` + re-evaluate at the live seed (2.7);
  Cancel discards.
- **Text mode toggle**: a single-line input showing `formatExpr` output,
  parsed by `parseExpr` on the fly with inline errors — the desktop fast path
  and the escape hatch for expressions the palette makes tedious. Round-trip
  identity (print∘parse) is a pinned test, so the two modes can never drift.
- **Desktop**: same component anchored as a popover near the cell; scrubbing
  works with the mouse; keyboard focuses the text mode directly.

### 4.2 Why this fits the codebase

Every primitive exists: measured fixed-position popovers (DocsPopover/RowInfo),
pointer-capture drag with threshold + commit-once (timeline strip), take-based
recording (sliders), the humble-controller Solid idiom, and the `tick`-bump
store bridge. The new code is one component (`src/ui/expr-sheet.tsx`), one
pure text module (`src/expr-text.ts`), the EditableCell dispatch branch, and
the small playback ctx accessor.

---

## 5. Editor, docs, completions

- JSDoc on new `Expr` methods and `ExprNamespace` members → regenerate
  `lang-env.json` (build already does) → TS-service completions and hovers
  pick them up automatically; bump the service-worker precache so stale caches
  don't pin the old surface.
- Extend the hand-kept `EXPR_METHOD_DOCS`/`EXPR_NAMESPACE_DOCS`
  (`editor-support.ts:95-120`) — they drive curated prose, completion boost,
  the offline heuristic fallback, and the DocsPopover reference tab.
- No new `CodeLanguage` needed: the sheet edits AST, not text; code cells keep
  their existing languages. (If a text-first expr cell language is ever
  wanted, the recon documented the exact recipe — `CodeLanguage`/`EditorLang`
  split points — but it's not on this plan's path.)

---

## 6. Tests (behavioral contracts only, per CLAUDE.md)

- **expr**: call-node eval for a representative spread (`sin`, `clamp`,
  `lerp`); streaming-ness propagates through call args; unknown node kind
  evaluates to 0 and fails validation; hash stability for call nodes.
- **progress**: a post `set` row with `dur` whose value expr uses
  `progress()` resolves 0→1 across the window and 1 after; a scene update
  keyframe's expr sees per-field segment progress; progress-only exprs bake
  to numbers; source nodes are not mutated by substitution (memo safety).
- **rasterize**: the numeric/expr/numeric keyframe sandwich samples the expr
  in its span (no lerp-through) — for a RESERVED field *and* a non-reserved
  light numeric; string `ease` resolves via EASINGS.
- **post fold**: tween with an expr target emits a lerp composite that
  resolves per frame; a pulse over an expr base stacks (today: dropped);
  numeric-only rows byte-match today's behavior (existing pinned tests
  unchanged); `field()` in a value cell reads the row, not sibling vars.
- **cells**: `cellValid` accepts a valid marker in an expr-flagged number
  column, rejects it in unflagged and string columns and rejects malformed
  nodes (update both pinned tests); hydra `replace` with an expr value flags
  invalid; seeding `editable()` with `Expr` instances lands markers, not dead
  objects (the 2.1 regression).
- **expr-text**: `parseExpr(formatExpr(node))` round-trips a corpus of nodes
  (lands in phase 4 with the parser).

---

## 7. Phasing

1. **Core AST** — call node + registry + `progress`/`field` substitution
   rules + validator + never-assert defaults; `formatExpr`; JSDoc/docs/
   lang-env. Pure, no UI. (1.x, 5)
2. **Cell safety + display** — seeding fix, `expr` column flag + `cellValid`
   (both arms), row-level rules (hydra `replace`), `formatExpr` wiring,
   EditableCell dispatch gate with inert chip + revert affordance (expr cells
   become safe and legible before they become editable). (2.1–2.3)
3. **Consumers** — post foldVars composites + substitutions, rasterize expr
   keyframes in the track scan + progress substitution + string ease,
   `schemas.scene` (+ scene columns join the expr flag), three-scene NaN
   guards, slider declaration walk. (2.4–2.6)
4. **The expr sheet** — component, scrub, live readout + playback ctx
   accessor, `parseExpr` + text mode, apply-on-commit, desktop popover mode;
   sample + tutorial text. (4, 2.7)
5. **Polish** — graph markers for expr points, mid-gesture canvas preview
   (visualizer row patching), `layer`/bauble revisit, resolve-then-lerp
   keyframe glides.
