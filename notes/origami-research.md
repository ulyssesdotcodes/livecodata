# Origami engine research (2026-07-13)

Why the crease-table fold engine keeps failing, what exists in the origami-software
world, and the options for rebuilding the visualizer. Compiled from a five-agent
research sweep (theory/landscape, Origami Simulator internals, flat-folder,
Rabbit Ear, fold-sequence animators) plus a review of this repo's history.

**Goal recap:** a table with rows of fold steps that can be animated to watch the
paper fold into shape. Faces must move in sync via shared vertices (no tearing).
Paper passing through paper mid-motion is acceptable. As much as possible should
be computed statically. Ideally an LLM can author the fold table straight from a
crease diagram.

---

## 1. What this repo has tried (git archaeology)

Five architectures, each abandoned when the crane got harder:

| Era | Approach | Key commits/PRs |
|---|---|---|
| 1 | Live crease-pattern engine in three.js, then a "table of physical fold steps" driving it | `005a40c`, `1a1beb0`, PR #59–60 |
| 2 | Stepwise folding with rests; then rigid kinematics ("let the sheet break") | `59a7b16` PR #61, `b8e12ef` PR #62 |
| 3 | Reflection stitching ("fold by instructions: reflect along two points on known edges") | `d302375`, `875a176`, PR #63–64 |
| 4 | Hand-solved vertex-mechanism squash collapse for the square base | PR #65–67 |
| 5 | Static crease table: `compileFolds` cuts faces per crease row, heuristic hinge ownership, spanning tree; `createFoldPlayer` interpolates dihedrals and averages welded vertices | `dd28809` onward, PR #68 (`claude/origami-crane-petal`) |

State of approach 5 at stop time: square base/bird base/neck/tail work as flat
snap-states, but the wing step is kinematically dead (its crease chain fails to
sever the flap through every ply, so the spanning tree bypasses its hinges), the
final state carries 0.26 units of edge strain, and the model renders upside-down.
Every new crease re-cuts the sheet and re-derives hinge ownership globally, which
is why adding head/wing creases regressed the previously-working square base.

## 2. Why approach 5 fails structurally (theory)

- **Non-rigid steps cannot be interpolated kinematically.** The bird base contains
  degenerate flat-foldable vertices; petal folds and inside-reverse folds have *no*
  rigid-panel intermediate states. Interpolating dihedral angles along a spanning
  tree must therefore tear or strain mid-motion — it is a theorem, not a tuning
  problem. (Refs: Akitaya/Demaine/Horiyama/Hull/Ku/Tachi, "Rigid foldability is
  NP-hard", JoCG 2020, arXiv:1812.01160; "Robust Folding of Elastic Origami",
  arXiv:2109.10989 — researchers fold a *modified* bird base because the
  traditional one is not rigidly foldable.)
- **Layer ordering is the real hard problem.** Bern & Hayes (SODA 1996): global
  flat-foldability and valid layer ordering are NP-hard, even given a valid
  mountain/valley assignment. Our per-crease "hinge ownership" heuristic is an
  ad-hoc, non-local approximation of this, recomputed from scratch on every
  re-cut.
- **Authoring is brittle with no verifier.** One missed ply in a crease chain
  silently kills a step (dead hinge, bypassed tree). Nothing checks a row's
  geometric validity when it is written.

## 3. Theory cheat-sheet (what matters for a visualizer)

- **Flat-folding map:** a flat fold is a piecewise isometry. Fix a base face; every
  face's placement is the composition of reflections across the creases along any
  path in the face-adjacency graph (Kawasaki guarantees path-independence). Exact
  folded coordinates for the whole sheet in O(faces), zero physics, zero
  divergence. This is the engine inside ORIPA, flat-folder, and Rabbit Ear.
- **Local flat-foldability checks:** Kawasaki–Justin (alternating sector angles sum
  to 180°) and Maekawa–Justin (|M − V| = 2 per interior vertex). Linear time;
  these are the per-row verifier primitives.
- **Layer ordering as CSP:** Akitaya/Demaine/Ku (OSME 2024) reduce layer ordering
  to boolean variables over overlapping face pairs with four constraint families —
  taco-taco, taco-tortilla, tortilla-tortilla, transitivity — solved by
  propagation + component-wise backtracking. Fast in practice at model scale.
- **Huzita–Justin axioms:** the seven single-fold alignments (complete for single
  folds). Useful as the vocabulary for "fold A to B"-style commands and for
  constructing crease lines from landmarks.
- **Fold sequences in FOLD format:** `file_frames` with `frame_parent` /
  `frame_inherit` encode a sequence as diffs on a parent frame — the standard
  interchange for step sequences.

## 4. Tool landscape

Research clones live outside the repo (scratchpad); pin commits noted for re-fetch.

### flat-folder — Jason Ku (MIT) — pinned `d500048` (2026-06-25)
https://github.com/origamimagiro/flat-folder
- ~4,600 lines vanilla JS, ES modules, **zero dependencies, no build step**.
- Core (`math.js`, `avl.js`, `constraints.js`, `conversion.js`, `solver.js`,
  `note.js`, ~1,800 lines) is **DOM-free — verified running headless in Node 22**.
- Exact folded geometry: `X.V_FV_EV_EA_2_Vf_Ff` (conversion.js:338) walks a face
  spanning tree composing reflections; returns folded coords `Vf` + face parity `Ff`.
- Layer orders: overlap cells → boolean variables per overlapping face pair
  (`X.EF_SP_SE_CP_CF_2_BF`) → taco/tortilla/transitivity propagation + component
  backtracking (`src/solver.js`). Outputs FOLD-spec `faceOrders`.
- Inputs FOLD/CP/OPX/SVG; outputs FOLD with `faceOrders`.
- **Measured (this container, Node):** crane.svg 72 faces / 892 variables →
  137 ms end-to-end; ≤120-face models: median setup 14–25 ms, solve <1 ms.
- Naming is terse (`I1_I2_2_O1` convention) — read `src/NOTATION.txt` first.
- Paper: Akitaya, Demaine, Ku, "Computing Flat-Folded States", OSME 2024.

### line-folder — Jason Ku (MIT) — pinned `14d027e` (2026-07-09)
https://github.com/origamimagiro/line-folder
- **The per-step machinery, already built.** Vendors flat-folder's core verbatim.
- `MAIN.make_fold` (main.js:645): cut faces along a fold line drawn on the folded
  state; `COMP.reflect` (compute.js:216) reflects the moving set; **carries the
  previous step's faceOrders into the next solve as the initial assignment**
  (main.js:686); classifies each resulting state (Pureland / inside-reverse /
  outside-reverse / open-sink / closed-sink / complex).
- Exports multi-frame FOLD: one `file_frames` entry per step with folded
  `vertices_coords`, `faces_vertices`, `faceOrders`, plus `lf:line`, `lf:points`,
  `faces_lf:group` describing the fold op. `examples/crane.fold` has 18 frames.

### sequence-folder — Jason Ku (MIT) — pinned `e5978d7` (2026-06-25)
https://github.com/origamimagiro/sequence-folder
- Companion step viewer. Recovers each frame's CP by unfolding (main.js:99);
  `linearize` (main.js:266) converts pairwise faceOrders into total layer indices
  via topological sort — exactly what z-nudged rendering needs.

### Origami Simulator — Amanda Ghassaei (MIT) — pinned `7855983` (2025-11-19)
https://github.com/amandaghassaei/OrigamiSimulator · origamisimulator.org
- Compliant dynamics: triangulated sheet, three force families — axial edge
  springs, angular crease springs driving each dihedral toward
  `foldPercent × targetAngle`, and face-shear constraints. Explicit Euler/Verlet,
  entirely in GPU fragment shaders (~690 lines GLSL inlined in index.html;
  orchestration `js/dynamic/dynamicSolver.js`). Paper: Ghassaei/Demaine/
  Gershenfeld, 7OSME 2018.
- **One indexed shared-vertex mesh** (model.js:291–342); triangulation diagonals
  become flat "facet" creases so facets can bend — the source of the paper look.
- Fold percent is a single uniform, but per-crease target angle *and stiffness*
  live in a re-uploadable RGBA texture (`u_creaseMeta`, `updateCreasesMeta()`,
  dynamicSolver.js:481) → **per-step crease groups is a ~20–40 line change**
  (ramp active group's targets; keep future creases at k≈0).
- ~100 solver sub-steps/frame; built-in strain-error metric usable as a
  convergence gate for offline baking. Deterministic given fixed dt/steps → can
  bake vertex keyframes headless (Playwright WebGL, or port ~300 lines of GLSL
  force math to CPU TypeScript).
- **No self-collision** — tucks pass through paper.
- No CPU solver in practice (static/rigid solvers are commented out).
- **robbykraft/OrigamiSimulator** pinned `152c7a7` (2024-11-02): TypeScript
  rewrite, solver decoupled from UI, FOLD-only input, deps just earcut +
  three@0.169. Same `u_creaseMeta` layout, so the per-group change applies there.

### Rabbit Ear — Maya/Robby Kraft (**GPL-3.0**) — pinned `b717948`, npm `rabbit-ear@0.9.4`
https://github.com/rabbit-ear/rabbit-ear · rabbitear.org
- The most complete origami library: FOLD-native graph ops;
  `foldGraph`/`foldLine` (src/graph/fold/foldGraph.js) folds along a line
  *through the folded form*, splitting faces, transferring new vertices back to CP
  space, assigning M/V, and incrementally updating faceOrders, returning a change
  delta; folded coords via `makeVerticesCoordsFolded`; working layer solver
  (`src/layer/`, bird base 20 faces solved in 34 ms here); all 7 axioms with
  in-polygon clipping and validation (src/axioms/) — the best LLM-facing
  construction API found; per-crease `edges_foldAngle` animation verified.
- JS + shipped .d.ts, zero deps, 206 test files. Dormant since mid-2024 (author
  active on rabbit-ear-app). Dev branch has unreleased `simpleFold`/`reverseFold`/
  `squashFold` ops worth mining.
- **License blocker:** livecodata is BSD-3-Clause; importing GPL code at runtime
  makes distributions effectively GPL. Safe uses: design reference, or build-time
  generator whose *data output* ships.

### Others (reference only)
- **FOLD format + `fold` npm** (MIT), Demaine/Ku: https://github.com/edemaine/fold —
  spec for geometry, M/V/F/B/C assignments, `edges_foldAngle` (±180, +=valley),
  `faceOrders` `[f,g,±1]`, `file_frames` sequences. The interchange everything
  else speaks.
- **Origuide** (GPL-3.0, Python+JS, dormant): https://github.com/maciekmm/origami ·
  origami.wtf — master's thesis; the closest architecture precedent: per-step
  Ghassaei-style solve done offline, precomputed frames played in three.js.
- **ORIPA** (Java, GPL) / **Oriedita** (Java, active) — CP editors with folded-form
  estimation; FOLD import/export; upstream authoring tools, not embeddable.
- **Tachi's Rigid Origami Simulator / Freeform Origami** — closed freeware; the
  4OSME paper "Simulation of Rigid Origami" is the recipe if a rigid-fold player
  is ever wanted (fold-angle velocities projected onto the constraint Jacobian's
  null space).
- **TreeMaker** (Lang) — CP *design*, irrelevant to visualization.
- **foldMation** (closed web app) — fold-command DSL (fold-to, inside-reverse,
  crimp, pleat over named bases); the best existing template for an LLM-authored
  fold-table grammar.
- **Academic:** Miyazaki et al. 1996 (first step-based origami simulator; stack of
  flat polygons + explicit layer bookkeeping); **Akitaya et al. 2013** ("Generating
  folding sequences from crease patterns", SIGGRAPH poster) — derives a diagram
  sequence from a finished CP by unfolding one flap at a time: the canonical
  crease-diagram → fold-table algorithm, same facewise machinery as flat-folder.
  2026 LLM work (OrigamiBench arXiv:2603.13856, Learn2Fold arXiv:2603.29585):
  LLMs fail multi-step folding without a deterministic geometric verifier in the
  loop — author-then-verify is mandatory.

## 5. Options considered

**Option 1 — exact static keyframes (flat-folder / line-folder core, MIT). CHOSEN.**
Each table row = one fold: a line (two points or landmark refs) + moving side
(+ optional target angle for final decorative poses). Per step, statically: cut
faces along the line through the folded state, reflect the moving set, solve the
layer order seeded from the previous step, z-order by linearized faceOrders.
Animation = rotate the moving set rigidly about the fold line 0→180°, snapping to
the exact next state. Key insight making this tear-free: after the cut, *every*
edge between a moving and a static face lies on the fold line in the folded
state, i.e. on the rotation axis — the motion is a perfect compound hinge with
shared vertices; the only artifact is paper-through-paper mid-swing (accepted).
End states are computed, never integrated → divergence is impossible by
construction. Fully deterministic, no physics, no WebGL dependency.

**Option 2 — baked compliant dynamics (Origami Simulator model, MIT).**
Table row = crease group + target angle + timing; bake vertex keyframes at
compile time by ramping per-group targets through the relaxation solver. Most
paper-like motion (facets bow); handles non-rigid steps gracefully; but final
states are near-exact rather than exact, stiffness needs tuning, and it needs the
GLSL force math ported to CPU or headless WebGL baking.

**Option 3 — hybrid (end-state).**
Option 1's exact states and verifier as ground truth; Option 2's solver used only
for in-between frames (seed at state N, activate step N+1's creases, blend into
exact state N+1). No published tool does this end-to-end; all pieces are MIT.

**Decision (user, 2026-07-13): start with Option 1.** No backward compatibility
with the old engine — `src/origami.ts` and the crease-table samples are dead code
once replaced, and should be deleted. The table schema is designed fresh; Option
2's baked in-betweens can slot behind the same table later as polish.

## 6. Option 1 implementation plan

1. Vendor flat-folder core (`math.js`, `avl.js`, `constraints.js`,
   `conversion.js`, `solver.js`, `note.js` @ `d500048`, MIT headers kept) under
   `src/flatfolder/`; treat as frozen third-party (no reformatting).
2. Adapt line-folder's step loop (`compute.js` + the relevant parts of
   `main.js:make_fold`) into a typed `src/fold-engine.ts`:
   `foldStep(state, line, side, opts)` → next state {Vf, faces, faceOrders,
   moving-face set, crease segment} with faceOrders carry-over; plus
   sequence-folder's `linearize` for per-face layer indices.
3. New fold-table schema (editable table rows), designed fresh: `step`, fold
   line (`p1`, `p2` in the *current folded view*, or landmark refs later), `side`
   sample point marking the moving half, optional `kind`/`pick` to disambiguate
   among enumerated layer states (simple vs reverse fold), optional final `deg`,
   schedule `at`/`dur`. The old engine (`src/origami.ts`), its player, and the
   crease-table crane/frog samples are deleted once the new path renders.
4. Player: per beat, either hold an exact state (z-nudged by layer index) or
   animate the current step's moving set rotating about its crease line; single
   shared-vertex position buffer, per-face z-nudge applied at render time.
5. Verifier surface: reject rows whose line misses the model, whose fold has no
   valid layer order, etc., with row-level error messages (this is what makes
   LLM/human authoring reliable).
6. Crane sample expressed as ~18 line-fold rows (line-folder's
   `examples/crane.fold` is the reference sequence); later, the frog.
7. Later (not now): Akitaya-2013-style automatic sequence generation from a full
   crease pattern; Option 2 in-betweens.

## 7. Failure modes to watch (from the research)

- line-folder enumerates *multiple* valid layer states per fold; animation
  continuity requires seeding from the previous step's orders (it does this) and
  the table needs a disambiguator when >1 state survives.
- flat-folder's snap-rounding epsilon auto-tuner can fail on dirty input lines —
  surface its "precision error" path as a row error rather than a crash.
- Non-flat final angles (wings at 90°) only work as terminal steps — no flat
  solve exists on top of a 3D pose; validate that ordering.
- Uint16-style index limits and per-face triangulation live in our renderer, not
  the core — keep face polygons intact in the engine and triangulate only at
  render time.

---

## 8. Spike results (2026-07-13, this branch)

Vendored the core (`src/vendor/flatfolder/` @ d500048, `src/vendor/linefolder/compute.js`
@ 14d027e, both MIT, import paths adjusted only) and replayed line-folder's
`examples/crane.fold` (17 recorded folds) headless in Node:

- **16 of 17 steps replay exactly**: folded geometry matches the recording
  (up to the old recorder's per-frame renormalization, recovered as a tracked
  similarity transform), the recorded layer order is found among my enumerated
  states, and the animation axis invariant (every moving/static shared vertex
  lies on the fold line) holds at every step. Whole replay runs in seconds.
- Fold-table rows extracted in a stable unit-square frame:
  `line [u,d] + sheet-space move markers + kind + pick`, with kind ∈
  {Pureland, Inside Reverse} and pick ∈ {0, 1} throughout — the disambiguation
  surface is tiny in practice.
- **Step 17 of the recording is invalid under the current solver**: its stored
  faceOrders violate a taco-tortilla constraint on the recorded geometry itself
  (verified by feeding the recorded orders into `SOLVER.initial_assignment`),
  and 358 of 1344 order variables aren't covered by the stored orders — the
  example predates current constraint code. Not an engine bug; the crane
  sample's final fold must be authored fresh.
- Recorder-vs-current version skew also explains the per-frame normalization;
  the new engine keeps one stable world frame and never renormalizes.

Engine mechanics validated: `split_FOLD_on_line` carries sheet coordinates
through splits; `get_groups` + sheet-space markers select single plies
unambiguously (a sheet point names exactly one face); `filter_clicked_and_reflect`
run twice with identical maps carries both folded and sheet coords;
carry-over `faceOrders → BA0` seeding keeps per-step enumeration tiny
(≤ 33 states on the crane).

---

## 9. Option 3 implemented (2026-07-13, soft in-betweens)

`src/fold-relax.ts`: a ~200-line CPU port of the Origami Simulator force
model — axial springs on every triangulated edge, discrete-hinge angular
springs driving each crease's dihedral to a target, kinetic damping
(velocities zeroed at kinetic-energy peaks), explicit integration with dt
from the stiffest spring (hinges enter as k/h²). Guards that mattered:
floor the hinge lever arm (a transiently degenerate triangle otherwise
kicks the mesh into orbit — one frame hit |x| ≈ 17,000 before the guard)
and clamp per-iteration displacement.

Integration: `foldStep` now emits the crease network with per-edge
dihedral targets before/after the fold (from the carried orders with the
movers' parity mirrored, and from the solved orders; empirically
calibrated sign: 'V' is negative in the hinge convention — verified by a
single-hinge micro-test after the first cut had the torque sign backwards
and exploded). `compileFoldTable` bakes non-Pureland steps: 16 keyframes,
seeded by the rigid swing at t≈0.05 so each flap breaks symmetry toward
the side it lands on, largest static face pinned, endpoints eased into the
exact states (smoothstep over the first/last 15%). Playback samples the
bake — no physics at runtime.

Numbers on the crane: compile 2.6 s (10 soft steps), peak transient edge
strain 15.6 % on one pocket edge mid-reverse-fold (the paper must bow —
reverse folds have no rigid path), endpoint error ~1e-4 before blending.
The collapse and neck folds visually reproduce the old hand-tuned
choreography's pocket-opening quality, from table rows alone.

---

## 10. Soft motion, take 2 (2026-07-13): what worked and what didn't

Iterated with per-step screenshot strips. Findings:

- **Shallow folds (≤ ~20 faces) relax beautifully** — the square-base
  collapse's pockets billow open and press flat; this is where the
  compliant solver earns its keep.
- **Deep-stack reverse folds (neck/tail/head, 44–60 faces, 8+ overlapped
  plies) resist relaxation.** Five attempts, all read as crumpling:
  uniform stiffness (whole body blossoms open), differentiated stiffness
  (stiff ratios make the ODE stiff — explicit relaxation under-converges;
  strain 15% → 107% at ratio 8), local pinning of everything away from the
  action (over-constrains, tears at the free/pinned boundary),
  choreographed targets (pocket flanks open sin(πt) then press — best of
  the five, point visibly sweeps through, body still splays), pocket
  scoping via the solved layer overlaps (differently messy).
- **Shipping rule: soft bake only for completing non-Pureland steps with
  ≤ SOFT_MAX_FACES (20); everything else keeps the rigid swing.** Clean
  everywhere, paper-like where the solver is competent, compile 0.85 s.
- **`kind: "crease"` rows** (cut all plies along a line, fold nothing, no
  timeline slot) are in — note that pre-creasing a fold's own line is
  redundant (every fold already cuts all plies along its line); crease
  rows matter for bend lines elsewhere.
- **The remaining path to soft deep reverses** is the analytic route, not
  tuning: a symmetric inside reverse fold is a 1-DOF rigid mechanism
  (flat-foldable degree-4 vertices) — parameterize by the spine angle,
  flanks and reverse creases follow in closed form. Moderate work,
  deterministic, no solver.
