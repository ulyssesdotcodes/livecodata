# Plan: math in Expr, expr cells as text, and editor-level GUI

Goal: any numeric attribute of the scene ("three") table and any post-table
variable (`set`/`pulse` `value` cells) can hold a live math expression instead
of a literal — editable from the table panel, syncing and replaying like every
other cell. Expressions gain real math (sin, min, clamp, lerp, …) and a
`progress()` source reading the enclosing event's percent-done (0→1 across
its duration).

Design principle (v2, after review): **cells store expression TEXT and the
cook evaluates it — the post-cell process, reused.** A cell holds
`=slider("h").mul(2)` (spreadsheet-style `=` prefix); the cook worker
evaluates it against the expr scope per row, producing exactly what
`derive()` produces today — a number, or a streaming `{ $expr }` binding that
playback already resolves per frame. Editing happens in the one CodeMirror
editor via the existing cell-target mode. The `{ $expr }` marker stays what
it is today: an in-memory cook artifact, regenerated every run — **never a
persisted format**.

What this deletes from the v1 (AST-in-cell) design: the bespoke bottom-sheet
token editor, the expression parser *and* pretty-printer, the node validator
and its cross-version wire-format story, the per-column `expr` flag
machinery, the Expr-instance seeding fix (seeds are strings), the slider
declaration walk (falls out of the existing path), and most of the cell-editor
safety surface. What survives untouched: the AST/consumer work (§1, §3),
which was never GUI-dependent.

---

## 1. Math in the Expr AST

### 1.1 One generic call node + a function registry

```ts
| { k: 'call'; fn: string; args: ExprNode[] }
```

with a registry as the single source of truth (the `POST_OPS` idiom):

```ts
export const EXPR_FNS: Record<string, { arity: number; apply: (...ns: number[]) => number; doc: string }>
```

Contents: `sin cos tan asin acos atan atan2 abs floor ceil round sqrt exp log
sign pow min max clamp lerp fract wrap` — all pure and deterministic (no
`Math.random`, no wall clock; determinism is what makes replay/scrub exact).
Constants `pi`/`tau`/`e` as `lit` sugar. The registry feeds `evalExpr`, the
cell-eval scope (§2.2), and the editor docs (§5) — add a function once, it
appears everywhere.

### 1.2 Surface and switches

- Chainable methods (`.sin()`, `.abs()`, `.clamp(lo, hi)`, `.pow(e)`) plus
  namespace multi-arg forms (`expr.min(a, b)`, `expr.lerp(a, b, t)`). Cell
  text is evaluated as JS, so expressions are chains — `slider("h").mul(2)`,
  not infix `slider("h") * 2` (JS operators can't build AST nodes). The
  registry also provides bare wrapper fns in the cell scope (`sin(x)` ≡
  `x.sin()`) so cells read naturally.
- Both exhaustive switches learn the node (`dsl.ts`):
  - `isStreamingNode`: `case 'call': return n.args.some(isStreamingNode)` —
    critical, or `sin(slider("x"))` bakes to a constant instead of deferring.
  - `evalExpr`: look up `EXPR_FNS[n.fn]`, `Number()`-coerce args, apply.
- Runtime default without losing the compile check: bindings still cross the
  cook-transfer boundary, so give both switches a never-assert default
  (`default: { const _x: never = n; void _x; return false }`) — a forgotten
  case on the closed union stays a TS2366-style compile error while an
  out-of-type node degrades at runtime instead of NaN-ing. (With text as the
  persisted format this is belt-and-braces, not the compat story: an old
  client meeting a new function name just fails to evaluate that cell — §2.4.)
- JSDoc every new member — `gen-lang-env.js` lifts it into hover/completions
  on rebuild (§5). Keep every node kind's key set distinct from cook-transfer's
  single-key `{ $fn: string }`, and no row column named `$lineage`.

### 1.3 `progress()` — percent-done of the enclosing event

New streaming node `{ k: 'progress' }`, surfaced as `expr.progress()` /
`progress()` in cells: 0→1 across the duration of the event (row) the
expression lives on, so a `set` row can shape its own tween
(`progress().mul(tau).sin()`) and a scene keyframe its own segment.

Implementation is **substitution at fold/bake time, not a new EvalCtx
member**: the places that know both the row's window and the current frame
build a per-frame clone of the node path down to each `progress` node,
replacing it with `{ k: 'lit', v: u }` — **never mutating the source node**
(nodes live inside memoized rows; an in-place rewrite would freeze the first
u into the cook memo). Because substitution operates on bindings in rows —
however they got there — it benefits **code-created exprs identically**
(`derive({ py: expr.progress() })` on a keyframe works too):

- **post** (`post.ts` foldVars): `u = clamp01((frame - row.index) /
  durFrames)` — the u the tween already computes. `set` without `dur` → 1;
  `pulse` requires `dur` already. foldVars runs per playback frame, so this
  is a per-frame clone+eval — cheap, but the numeric-only fast path must skip
  it entirely.
- **scene** (`rasterize.ts` sampleObject): baked rows are per-frame; while
  carrying an expr value onto baked frame `i`, substitute u for that frame.
  Window, in order: the row's own `dur` if set (new semantics — transform
  keyframes don't read `dur` today); else to the **next keyframe carrying
  this field** (the per-field segment the expr spans — an any-keyframe window
  would plateau u at 1 mid-carry); else to the destroy frame or bake extent
  (thread the extent into `sampleObject`/`gatherExtra` — it lives only in
  `rasterizeRows` today). Substitution here happens once at cook; note the
  fidelity ceiling: baked u quantizes to the FRAMES_PER_BEAT=30 grid while
  `time()`-driven exprs stay continuous per render frame.
- After substitution, an expression with no other streaming node evaluates
  right there and lands as a plain number.

`isStreamingNode('progress') = true`; unsubstituted `progress` reaching
`evalExpr` evaluates to 1, the graceful degrade. This subsumes the `phase()`
idea in `notes/dsl-live-coding-plan.md` C2 for events.

### 1.4 `field()` in vars cells — same substitution

`resolveBindings` for post/hydra variables passes the **vars map** as the row
(`visualizer.ts:155,237`), so `field("beat")` in a post `value` cell would
read a sibling *variable*, not the table row. Give `field` the same fold-time
treatment: substitute `field` nodes with `lit(row[name])` where the fold has
the real row (post `foldVars`, hydra's setVariable fold at `hydra.ts:131`).
On the scene path `field()` naturally reads the baked row — no change.
Result: `field()` means "this row's columns" everywhere.

---

## 2. `=` cells: text in, binding out

### 2.1 Format

A cell whose value is a string starting with `=` is an expression cell. The
rest is a JS expression over the expr scope, evaluated to an `Expr` or a
number: `=slider("h").mul(2)`, `=progress().mul(tau).sin()`,
`=field("beat").mod(4)`. Plain JSON string — it rides the event log,
persistence, multiplayer, structured clone, and `ensure()` seed diffing with
zero new machinery, and it displays as itself (self-describing formula — no
pretty-printer). Program code seeds expr cells the same way:
`editable("fx", schema, [{ beat: 1, value: "=slider('glow')" }])` — strings,
so the v1 plan's Expr-instance structured-clone hazard never arises.

### 2.2 One shared eval module

New small module (usable from both the worker and the main thread — the
`sliderDeclsInCode` collector pattern): builds the scope — `ExprNamespace`
sources, bare `EXPR_FNS` wrappers, `progress`, `field`, plus the `expr`
namespace itself — and evaluates `text.slice(1)` with `new Function`
(the same trust model as post/hydra/code cells, which peers already sync and
evaluate). Result contract: `Expr` → `bakeExpr` per row (streaming → binding,
constant → number, exactly `derive()`'s semantics); number → itself; anything
else / throw → the cell is invalid and the cook uses the column default (the
"broken post cell declares nothing" precedent). Memoize compilation by text.

**Where it runs in the cook**: `dsl.editable()` maps served rows — evaluate
`=` cells there, per row. Because that executes inside the worker runtime,
`expr.slider("h", 0, 2)` in a cell hits the runtime's `defineSlider`
(`cook-service.ts:89`) and the control appears via the **existing**
declaration path — the v1 plan's slider-declaration walk (§2.6) is deleted,
not moved.

### 2.3 Validity and eligibility

- `cellValid` accepts an `=` string in a **number** column when it compiles
  and evaluates to Expr/number (shared module; memoized); a broken one flags
  red exactly like a wrong-typed value today. This relaxes the pinned
  number-column contract — update `test/editable-tables.test.ts`
  deliberately.
- **Timing columns**: an `=` cell whose result is *streaming* is invalid in
  `beat`/`dur`/`end`/`loop` (a hardcoded name set, the RESERVED/NO_TRACK
  precedent) — a binding there NaNs rasterize's frame math and drops rows
  from the timeline strip, all silently. A *constant* expr in those columns
  is fine: it evaluates to a plain number before anything sees it.
- **Row-level rule** (in `invalidColumns`, which sees the whole row): hydra
  `replace` rows reject `=` values — the fold splices `String(row.value)`
  into sketch code (`hydra.ts:142`). Post `layer` needs no rule (`amountExpr`
  already degrades objects to `'0.5'`); bauble `value` exprs are simply
  documented as recompile-per-frame (constant exprs fine); particles ignore
  non-numbers today (inert, documented).

### 2.4 Version skew, solved by text

Old clients meeting a cell that uses a newer function get a `ReferenceError`
at eval → invalid-red cell + column default at cook. No NaN, no crash, no
persisted-AST versioning: text is the format, and bindings remain cook-local.

### 2.5 Cell editing = the existing cell-target mode

`EditableCell` gets one small dispatch: an `=`-string value routes to
`props.onEditCell` (the code-cell path) instead of the inline editors —
`main.ts:117-144` already expands the collapsed mobile editor, opens
cell-target mode with a language, and its commit **already** does
`setCell` + `evaluate(liveCode, { seed: liveSeed })` — the apply-on-commit
semantics wanted, for free (a commit is a full Apply of all pending edits at
the last-applied program, same as code cells today). Display needs one
branch: `formatEditableCell`'s number arm shows `=`-strings as-is (covers
cells, timeline-strip readouts, events tabs). To *create* an expr from a
number cell, typing `=` as the first character hands off to the editor
(spreadsheet muscle memory; the inline input becomes `type="text"
inputmode="decimal"` so `=` is typable). This also closes the v1 clobber
hazard — an `=` cell never opens the coercing number editor at all.

Editor language: start with `'dsl'` (the TS service already completes
`expr.*` and Expr-method chains — test-pinned); add an `'expr'` lang-env
entry later for bare-name completions (`slider(`, `sin(`) via the documented
`CodeLanguage`/`EditorLang`/`env.langs` recipe (§5).

---

## 3. Consumers (unchanged from v1 — never GUI-dependent)

### 3.1 Scene ("three") table path

1. **`schemas.scene`** (new SCHEMAS entry + docs + a sample): `{ beat, id,
   type: ['create','update','destroy'], shape: [...], px..pz, rx..rz,
   sx..sz, color, dur, ease: ['linear','easeIn','easeOut','easeInOut'],
   disabled }`. Rasterize gains post-style `easingOf(string)` resolution —
   today it only honors function `ease`, which JSON cells can't hold, so
   editable keyframes always play linear. That fix stands alone.
2. **rasterize**: expr bindings join the per-field track scan as first-class
   keyframe values — a bolt-on carry pass is not enough, because the track
   write is the *last* writer into the baked row and would clobber the expr.
   Binding-valued keys join `names` (`:105`) and the prev/next scan (`:113`);
   lerp only when both prev and next are numbers, else hold prev (with the
   per-frame progress-substituted clone when prev is a binding). Expr
   keyframes thereby *terminate* numeric segments; numeric↔expr transitions
   **step** — gliding is expressed inside the expr via `progress()`/`time()`.
   Applies to **every tracked field, not just RESERVED** (light/camera
   numerics ride gatherExtra *and* the track loop; today the numeric track
   actively overwrites an expr update there). `color`: expr as step only;
   the `dur` pulse path bit-ops the value, so the row rule forbids that
   combination. This fix equally benefits code-created bindings
   (`derive` onto update keyframes is silently dropped today).
3. **three-scene**: sweep transform paths to guarded numerics
   (`numOr(v, default)`) — an unresolved/NaN value currently vanishes the
   mesh with no error; the error surface should be the invalid-cell flag,
   not a missing object.

### 3.2 Post variables path

`foldVars` (`post.ts:162-220`): tween guard requires numeric prev+target
(expr degrades to a step), a non-numeric base silently **drops pulses**, and
pulse values coerce to 0. Rework with composite nodes — the fold *constructs*
bindings, no EvalCtx needed:

- Tween with expr endpoint(s): emit `{ $expr: {k:'call', fn:'lerp',
  args:[prevNode, targetNode, lit(easedU)]} }` — u/ease are known per frame
  at fold time; endpoints resolve at the visualizer's existing
  `resolveBindings(frame.vars, ctx)`.
- Pulses over any base: nested `{k:'bin', op:'add'/'mul'}` nodes:
  `add(baseNode, mul(pulseNode, lit(env)))`.
- Numeric-only rows keep today's arithmetic fast paths byte-for-byte (pinned
  tests unchanged). `progress`/`field` substitution (§1.3/1.4) happens here.
- Cook/replay callers run foldVars ctx-free — composites keep that total, and
  `stateId` never sees set/pulse values, so exprs can't force a recompile.
- `val()`-derived rows: the dirty flag already protects a user's `=` edit
  from re-derivation clobbering. Two-clocks caveat to document: expr `time()`
  is source position; a chain's `p.time` is pass-adjusted (same as `derive()`
  today).

---

## 4. GUI: editor affordances that pay everywhere

The v1 bespoke bottom-sheet is replaced by CodeMirror extensions on the one
editor — which means every affordance works in expr cells, post/hydra/bauble
cells, **and the main program** (exprs created in code get the same tools):

- **Number-literal scrubbing** (the centerpiece): a decoration extension that
  detects numeric literals and lets you drag them — pointer capture +
  movement threshold (the timeline-strip pattern), horizontal to scrub,
  vertical distance for coarse/fine, `touch-action: none` on the handle.
  Preview updates the document text locally; release commits once via the
  existing cell-target `onCommit` (or Run for the program). One extension
  delivers the sheet's marquee interaction to every literal in every
  language: `bloom(0.6)` in a post cell, `value: 0.35` in the program, the
  `2` in `=slider("h").mul(2)`.
- **Mobile token bar**: a small insert-toolbar above the editor (a Solid
  sibling of the editor chrome, inserting at the cursor) — `slider("")`,
  `midi("")`, `time()`, `progress()`, `field("")`, `.mul()` `.add()`,
  `sin()` … Shown in cell-target mode on coarse pointers; useful for post
  cells too. Slider insertion needs no declaration plumbing — the cook
  declares on evaluation (§2.2).
- **Completions/hover**: already exist via the TS service; an `'expr'`
  lang-env entry adds bare-name completions for `=` cells (§5).
- **Later**: inline evaluated-value annotations (a widget showing what an
  expr/literal currently evaluates to at the playhead — needs a
  `getEvalCtxAt(srcFrame)` accessor on the playback API); color swatches on
  hex literals. Both are editor-level and language-agnostic, so they too
  benefit code and cells alike.

What's consciously given up vs the sheet: structured always-valid editing
(mid-edit text can be broken — the red flag + Apply gating already handle
that for every code cell) and chip-tap ergonomics for *building* expressions
on a phone (mitigated by the token bar + completions; and most edits after
creation are number tweaks, which the scrubber owns).

---

## 5. Editor, docs, completions

- JSDoc on new `Expr`/`ExprNamespace` members → regenerate `lang-env.json`
  (build already does) → TS-service completions/hover pick them up; bump the
  service-worker precache. Extend the hand-kept
  `EXPR_METHOD_DOCS`/`EXPR_NAMESPACE_DOCS` (`editor-support.ts:95-120`) —
  they drive curated prose, completion boost, the offline fallback, and the
  DocsPopover reference.
- `'expr'` as a `CodeLanguage`+`EditorLang` with its own env.langs roots
  (bare expr surface) — the recipe is documented in the recon: add to both
  unions, one `env.langs` entry in `gen-lang-env.js`, and the
  `editor-support.ts` gates; `main.ts` forwards declared languages unchanged.
  Ship after the core lands; `'dsl'` completions suffice meanwhile.

---

## 6. Tests (behavioral contracts only, per CLAUDE.md)

- **expr**: call-node eval for a representative spread (`sin`, `clamp`,
  `lerp`); streaming-ness propagates through call args; hash stability.
- **cell eval**: `=` text → binding for streaming, → number for constant;
  broken text → invalid + column default; `expr.slider` in a cell declares
  through the runtime; evaluation is deterministic across worker/main.
- **progress**: a post `set` with `dur` using `progress()` resolves 0→1
  across the window and 1 after; a scene keyframe sees per-field segment
  progress; progress-only exprs bake to numbers; source nodes never mutated
  (memo safety).
- **rasterize**: the numeric/expr/numeric keyframe sandwich samples the expr
  in its span (no lerp-through) — for a RESERVED field *and* a non-reserved
  light numeric; string `ease` resolves via EASINGS.
- **post fold**: tween with an expr target emits a per-frame-resolving lerp
  composite; a pulse over an expr base stacks (today: dropped); numeric-only
  rows byte-match today (existing pinned tests unchanged); `field()` in a
  value cell reads the row, not sibling vars.
- **cells/validity**: `=` accepted in number columns, streaming-`=` rejected
  in timing columns, hydra `replace` `=` rejected (update the pinned
  `cellValid` test); `=` cells display as themselves.

---

## 7. Phasing

1. **Core AST** — call node + registry + `progress`/`field` substitution
   rules + never-assert defaults + JSDoc/docs/lang-env. Pure, no UI.
2. **`=` cells** — shared eval module, `dsl.editable()` evaluation,
   `cellValid` arms (number/timing/replace rules), `formatEditableCell`
   branch, `EditableCell` dispatch to cell-target mode, `=`-typed handoff.
   Ships end-to-end usable (typed exprs, editor completions, apply-on-commit)
   before any new GUI exists.
3. **Consumers** — post foldVars composites + substitutions, rasterize
   binding keyframes in the track scan + progress substitution + string
   ease, `schemas.scene`, three-scene NaN guards.
4. **Editor affordances** — number-literal scrubber extension, mobile token
   bar, `'expr'` lang-env entry; sample + tutorial text.
5. **Polish** — inline evaluated-value annotations (playback ctx accessor),
   graph markers for expr rows, bauble/`layer` revisit, resolve-then-lerp
   keyframe glides.
