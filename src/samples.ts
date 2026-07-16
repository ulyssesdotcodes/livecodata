// Sample programs for the livecodata editor. CSV datasets are served from
// /data/ and loaded at run time via data(url) — no inline embedding needed.
//
// An example may also carry `tables`: seed rows for its editable tables, keyed
// by table name. These populate the table panel when the example is opened, so
// the program's editable(name, schema) call declares the column *schema* only —
// the row data lives here (edit it live in the panel), not as an array literal
// in the code. (Examples with no editable tables just omit `tables`.)
import type { Row } from './lineage.js'

export interface Sample {
  name: string
  code: string
  tables?: Record<string, Row[]>
  // The tab to show when the example is opened — its most relevant table (the
  // editable one you tweak, or the primary data/graph view). The panel falls
  // back to its default tab when omitted (see main's openExample).
  table?: string
}

// A URL-safe id for an example, derived from its display name (e.g. "CO2
// (Mauna Loa)" -> "co2-mauna-loa"), so a link can open a specific example
// directly (?example=<slug>) without needing a separate id field to keep in
// sync with `name`.
export const slugify = (name: string): string =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export const sampleIndexForSlug = (slug: string): number =>
  SAMPLES.findIndex((s) => slugify(s.name) === slug)

export const SAMPLES: Sample[] = [
  {
    name: "Editable Table",
    table: "path",
    code: `// livecodata — a sphere moved by an editable table
// Unlike every other example here, the path below isn't computed by code —
// it's data you edit directly, live, in the table panel on the right.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. editable(name, schema) declares a user-editable table: rows are
//    entered/edited in the table panel (its own "path" tab), not computed —
//    edits persist across runs, unlike a normal view. This table starts with
//    the keyframes seeded on the right; the schema is all the code carries,
//    and \`schemas.path\` is the canonical one for beat-timed positions —
//    hover it to see the columns ({ beat, px, py, pz, disabled }). Each
//    keyframe sits on a beat (1-indexed: beat 1 is the top of the loop). Try
//    it: open the "path" tab, click a cell to change a coordinate, or hit "+
//    row" to add a keyframe, then press Run again to see the sphere follow the
//    new path. (Every edit is recorded as an event too — see the "path·events" tab.)
//    "disabled" is just an ordinary boolean column, not a special mechanism —
//    check a row's box to mute that keyframe (the sphere skips it) without
//    deleting the row; uncheck to bring it back.
define("path", () => editable("path", schemas.path))

// 2. Turn the path's keyframes into a moving sphere: the first row (sorted by
//    beat, in case rows were added out of order) creates it; every later row
//    is an update, and playback interpolates position between consecutive
//    rows by their \`beat\`.
define("events", (rand, table) =>
  table("path").orderBy("beat").map((r, i) => ({
    id: "ball", type: i === 0 ? "create" : "update", beat: r.beat,
    shape: "sphere", color: 0x4a9eff, px: r.px, py: r.py, pz: r.pz, rx: 0, ry: 0, rz: 0,
  }))
)

// 3. Bake the sparse keyframes into a dense per-frame cache for playback —
//    8 beats long, so the sphere holds its last pose before the loop wraps.
define("scene", (rand, table) => table("events").rasterize(8))
`,
    tables: {
      path: [
        { beat: 1, px: -1, py: 0,   pz: 0 },
        { beat: 3, px: 1,  py: 1,   pz: 0 },
        { beat: 5, px: 0,  py: 0.3, pz: -1 },
      ],
    },
  },
  {
    name: "Text",
    table: "events",
    code: `// livecodata — text in the 3D scene
// A \`shape: "text"\` object is real extruded 3D text (three.js TextGeometry): it
// has depth, catches the scene's lights, and moves, spins and scales like any
// other object. The font is bundled, so it appears instantly — no asset to load.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// The text fields, alongside the usual px/py/pz + rx/ry/rz transform:
//   text   the string to draw (\\n splits into stacked, centered lines)
//   size   the cap height per line, in world units (default 0.5)
//   color  material color (default white) — recolors live, like any mesh
//
// \`text\` is just a normal column: it rides through rasterize untouched and
// steps to the newest value, so a later "update" row can swap the string
// mid-loop the way a color pulse does.
define("events", () => rows([
  { id: "title", type: "create", beat: 1, shape: "text", text: "livecodata",
    color: 0x4a9eff, size: 0.7, px: 0, py: 0.4, pz: 0, rx: 0, ry: 0, rz: 0 },
  // A second line that gently swings side to side while turning about y.
  { id: "sub", type: "create", beat: 1, shape: "text", text: "tables to visuals",
    color: 0xffd43b, size: 0.32, px: 0, py: -0.5, pz: 0, rx: 0, ry: -0.6, rz: 0 },
  { id: "sub", type: "update", beat: 9, ry: 0.6 },
  { id: "sub", type: "update", beat: 17, ry: -0.6 },
]))

// Bake to a 16-beat loop; the subtitle's ry keyframes ease back and forth as
// the loop repeats.
define("scene", (rand, table) => table("events").rasterize(16))
`,
  },
  {
    name: "Primitives",
    table: "things",
    code: `// livecodata — building 3D objects the easy way
// box/sphere/cylinder/cone/torus/text each build a ready-made "create" row for
// a scene object: beat 1, at the origin, no rotation — you set only the fields
// you care about. They return Tables, so concat them into a scene and
// rasterize. Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. A few primitives, laid out along x. Each helper's \`id\` defaults to its
//    shape name, so give distinct ids when you have more than one of a kind.
//    Sizes follow the shared schema: box → hx/hy/hz (half-extents),
//    sphere/torus → r, cylinder/cone → r + h (half-height); leave a size out
//    and the renderer's default for that shape is used.
define("things", () =>
  box({ id: "b", px: -2.4, color: 0x4a9eff })
    .concat(sphere({ id: "s", px: -1.2, r: 0.4, color: 0xff6b6b }))
    .concat(cylinder({ id: "y", px: 0, r: 0.3, h: 0.5, color: 0x51cf66 }))
    .concat(cone({ id: "c", px: 1.2, r: 0.35, h: 0.5, color: 0xffd43b }))
    .concat(torus({ id: "t", px: 2.4, r: 0.35, color: 0xcc5de8 }))
)

// 2. object(shape, props) is the generic behind the named helpers — handy for a
//    label. Here a line of 3D text floats above the row of shapes.
define("label", () =>
  text({ id: "caption", py: 1.4, size: 0.4, text: "primitives", color: 0xffffff })
)

// 3. Concat everything and bake an 8-beat cache. The scene is static here —
//    add "update" rows (or animate ry) to make it move, exactly like the
//    Text and Camera Move samples do.
define("scene", (rand, table) =>
  table("things").concat(table("label")).rasterize(8)
)
`,
  },
  {
    name: "Camera Move",
    table: "cubes",
    code: `// livecodata — moving the camera from the DSL
// The camera is just another scene object: \`camera([...])\` emits one keyframe
// per row (id "camera", shape "camera") that rides events → rasterize like
// anything else, so camera moves interpolate on the beat timeline for free.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. A little scene to look at: a 3×3 lattice of cubes on the floor. grid()
//    gives px/py/pz; each cell becomes a create row for a small box.
define("cubes", () =>
  grid(3, 3, { spacing: 0.8 }).map((c, i) => ({
    id: "c" + i, type: "create", beat: 1, shape: "box",
    color: 0x4a9eff, hx: 0.2, hy: 0.2, hz: 0.2,
    px: c.px, py: c.py, pz: c.pz, rx: 0, ry: 0, rz: 0,
  }))
)

// 2. camera([...]) — one row per keyframe. px/py/pz are the eye, tx/ty/tz the
//    look-at target (here always the origin), fov the vertical field of view.
//    Over the 16-beat loop the eye swings around the lattice and cranes up,
//    while the fov eases from wide to tight (a subtle dolly-zoom), then returns
//    to the start pose at beat 17 so the loop repeats seamlessly.
define("cam", () => camera([
  { beat: 1,  px: 0,    py: 0.5, pz: 5, tx: 0, ty: 0, tz: 0, fov: 60 },
  { beat: 5,  px: 4,    py: 1.5, pz: 3, fov: 55 },
  { beat: 9,  px: 0,    py: 3,   pz: -5, fov: 45 },
  { beat: 13, px: -4,   py: 1.5, pz: 3, fov: 55 },
  { beat: 17, px: 0,    py: 0.5, pz: 5, fov: 60 },
]))

// 3. Merge the camera keyframes with the cubes and bake the 16-beat cache.
define("scene", (rand, table) =>
  table("cam").concat(table("cubes")).rasterize(16)
)
`,
  },
  {
    name: "Origami Crane",
    table: "steps",
    code: `// livecodata — Origami Crane: a table of fold steps, solved exactly
// A square of paper folds itself into the traditional crane. Every row of
// the "steps" table is ONE FOLD, and each is solved exactly when the code
// runs: the paper is cut along the fold line, the chosen flaps swing over,
// and a layer solver works out how the paper stacks (seeded from the step
// before, so the folding stays coherent). Playback shows those exact
// states. Between them, simple folds hinge rigidly about the fold line;
// shallow reverse folds play a physically relaxed motion baked at compile
// time — pockets billow open and press flat the way real paper moves —
// and the deep ones (neck, tail, head) play the fold's exact rigid
// mechanism: the body opens around its spine, the point flips through,
// and everything presses flat again, landing exactly on the solved state.
// Every face shares its vertices with its neighbours, so the paper can
// never tear.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play.
//
// The 17 fold steps are seeded into the "steps" table on the right — the code
// here declares only their column schema; edit the steps live in the panel.
// Each column:
//   step   a name for the fold (errors point at it)
//   p1,p2  two points "x,y" on the fold line, drawn on the CURRENT folded
//          paper. The frame never moves: it is the unit square [0,1]² the
//          flat sheet started in
//   move   which flap(s) swing over: sample point(s) on the UNFOLDED
//          sheet ("x,y", ";"-separated), one inside each moving flap —
//          a sheet point names exactly one layer, so a single ply of a
//          thick stack can be picked out unambiguously
//   kind   for ambiguous folds, the move to make: "simple" (fold the flap
//          over), "reverse" (inside reverse fold), "sink", … — the solver
//          checks the paper really can fold that way
//   pick   when several stackings of that kind are valid, which one
//   at,dur when the swing starts, and how long it takes, in beats
//   to     how far to swing: 1 lands flat (default). Only the last row
//          may stop short — the wings hold at 0.5, half-raised
//   disabled  an ordinary boolean column: check a step's box to skip that
//          fold entirely (as if the row weren't there) without deleting
//          it — handy for previewing an earlier stage of the fold.
//
// A row that asks the impossible — a fold that cannot lie flat, a marker
// off the paper, a kind the geometry does not allow — fails with an error
// naming the step. Nothing folds wrong silently.

// \`schemas.steps\` is the canonical fold-table schema (the columns above) —
// hover it in the editor to see them typed out.
define("steps", () => editable("steps", schemas.steps))

// Feed the fold table to a sheet of paper, colored side DOWN (backColor)
// the way a crane is folded so the finished bird comes out colored. The
// fold value is one number: how many folds have landed (fractions = the
// next flap mid-swing), so scrubbing the timeline scrubs the folding.
define("events", (rand, table) => {
  const paper = origami().steps(table("steps"))
  return paper.spawn({ id: "crane", color: 0xf4efe2, backColor: 0xd94f2a, pz: 1.2, rz: 2.356 })
    .concat(paper.sequence())
})

// Bake to a 21-beat loop cache — hold the finished crane a moment, then
// the paper opens flat and folds itself all over again.
define("scene", (rand, table) => table("events").rasterize(21))

// A whisper of video feedback (the rendered scene is hydra's s0) so the
// paper leaves faint trails as it moves. Delete this view for a clean look.
define("hydra", () => rows([
  { beat: 1, event: "setCode",
    code: "src(s0).blend(src(o0).scale(1.003), 0.18).out(o0)" },
]))

// Things to try, live in the "steps" tab:
//   - Set the wings row's \`to\` to 1: the wings press flat, the classic
//     pressed crane; 0.35 barely lifts them.
//   - Delete the "head" row: everything else still folds — steps only
//     depend on the geometry before them, not on names.
//   - Or check "head"'s \`disabled\` box instead of deleting it: same effect
//     on the fold, but the step is still there (unchecked) to bring back.
//   - Nudge a p1/p2 a little: small nudges re-solve fine; ask something
//     impossible and the error names the offending step instead of
//     folding wrong.
//   - Slow a step down: give "neck" dur: 3 and watch the reverse fold
//     swing through.
`,
    tables: {
      steps: [
        // in half along the diagonal
        { step: "diag", p1: "0,0", p2: "1,1", move: "0.667,0.333", at: 1 },
        // collapse into the square base: four inside reverse folds
        { step: "collapse1", p1: "0,0.5", p2: "1,0.5", move: "0.333,0.167", kind: "reverse", at: 2 },
        { step: "collapse2", p1: "0.5,0", p2: "0.5,1", move: "0.833,0.667", kind: "reverse", at: 3 },
        { step: "collapse3", p1: "0,1", p2: "0.4142135624,0", move: "0.667,0.069036", kind: "reverse", at: 4 },
        { step: "collapse4", p1: "0,1", p2: "1,0.5857864376", move: "0.930964,0.667", kind: "reverse", at: 5 },
        // flatten the stray flap, then tuck the side corners in
        { step: "flatten", p1: "0,0.2928932188", p2: "0.7071067812,1", move: "0.930964,0.333", at: 6 },
        { step: "tuck1", p1: "0,1", p2: "0.4142135624,0", move: "0.069036,0.667", kind: "reverse", at: 7 },
        { step: "tuck2", p1: "0,1", p2: "1,0.5857864376", move: "0.667,0.930964", kind: "reverse", at: 8 },
        // kite folds onto the centre line, front then (after turning a flap
        // like a page) back — this thins the points into neck and tail
        { step: "kite1", p1: "0,1", p2: "0.6681786379,0", move: "0.525373,0.274808", pick: 1, at: 9 },
        { step: "kite2", p1: "0,1", p2: "1,0.3318213621", move: "0.897812,0.667", at: 10 },
        { step: "turn", p1: "0,0.2928932188", p2: "0.7071067812,1", move: "0.333,0.930964", at: 11 },
        { step: "kite3", p1: "0,1", p2: "1,0.3318213621", move: "0.667,0.897812", pick: 1, at: 12 },
        { step: "kite4", p1: "0,1", p2: "0.6681786379,0", move: "0.208238,0.583899", pick: 1, at: 13 },
        // swing the points up: neck, tail, then the head, all reverse folds
        { step: "neck", p1: "0.1345593806,0", p2: "0.4733251916,1", move: "0.906033,0.694263", kind: "reverse", at: 14 },
        { step: "tail", p1: "0,0.5266748083", p2: "1,0.8654406193", move: "0.246505,0.203815", kind: "reverse", at: 15 },
        { step: "head", p1: "0,0.1274716613", p2: "1,0.8431274379", move: "0.096435,0.080352", kind: "reverse", at: 16 },
        // both wings at once — front sheet and back sheet — held half-raised
        { step: "wings", p1: "0,0.1414213562", p2: "0.8585786438,1", move: "0.858,0.377;0.377,0.858", at: 17, dur: 1.5, to: 0.5 },
      ],
    },
  },
  {
    name: "Origami Cicada",
    table: "steps",
    code: `// livecodata — Origami Cicada: the traditional model, nine simple folds
// The classic cicada (semi), folded for nearly two centuries: halve the
// square, fold both corners up, sweep the tips back out past the edges
// for wings, fold two head layers down (leaving the stripe), then tuck
// the sides behind. Every row is one fold, solved exactly when the code
// runs — same fold-table dialect as the Origami Crane sample (see its
// header for the column notes). Press "Run", then hit Play.

// \`schemas.steps\` is the canonical fold-table schema — the rows are seeded
// in the table panel on the right, one fold each.
define("steps", () => editable("steps", schemas.steps))

// Colored side down, like the crane — the finished bug comes out green.
define("events", (rand, table) => {
  const paper = origami().steps(table("steps"))
  return paper.spawn({ id: "cicada", color: 0xf4efe2, backColor: 0x79b356, pz: 1.2, rz: -0.785 })
    .concat(paper.sequence())
})

// Bake to a 12-beat loop — fold, rest a beat, open flat, fold again.
define("scene", (rand, table) => table("events").rasterize(12))

// Things to try, live in the "steps" tab:
//   - Nudge wingL/wingR's p1/p2: the wings splay wider or tighter.
//   - Swap the head rows' move markers ("0.97,0.03" <-> "0.03,0.97") and
//     the stripe folds in the other order.
//   - Delete both tuck rows for the wide-bodied cicada variant.
`,
    tables: {
      steps: [
        // in half along the diagonal: the triangle, point down
        { step: "half", p1: "0,0", p2: "1,1", move: "0.667,0.333", at: 1 },
        // both corners up to the top point
        { step: "cornerL", p1: "0,0.5", p2: "1,0.5", move: "0.1,0.3;0.3,0.1", at: 2 },
        { step: "cornerR", p1: "0.5,0", p2: "0.5,1", move: "0.6,0.8;0.8,0.6", at: 3 },
        // wings: sweep each tip back down so they point away from each
        // other and stick out past the triangle's edges
        { step: "wingL", p1: "0.19885,0.598479", p2: "1.001892,0.99618", move: "0.03,0.12;0.12,0.03", at: 4 },
        { step: "wingR", p1: "0.401521,0.80115", p2: "0.00382,-0.001892", move: "0.88,0.97;0.97,0.88", at: 5 },
        // the head: one layer down over the wings, the second stops short —
        // that little gap is the cicada's stripe
        { step: "head1", p1: "-0.19,0.59", p2: "0.41,1.19", move: "0.97,0.03", at: 6 },
        { step: "head2", p1: "-0.24,0.64", p2: "0.36,1.24", move: "0.03,0.97", at: 7 },
        // narrow the body: fold the side corners behind
        { step: "tuckL", p1: "0.09,0.59", p2: "0.39,0.29", move: "0.05,0.55", at: 8 },
        { step: "tuckR", p1: "0.41,0.91", p2: "0.71,0.61", move: "0.45,0.95", at: 9 },
      ],
    },
  },
  {
    name: "Hydra Sketch",
    table: "hydra",
    code: `// livecodata — a video-synth sketch with hydra (hydra-ts, a port of ojack's hydra)
// A generative hydra sketch — no 3D scene involved (src(s0) can equally post-
// process a rendered scene, sourcing whatever the 3D view draws). Press "Run"
// (or Cmd/Ctrl-Enter), then hit Play.

// A hydra table is a stream of EVENTS, each placed on the loop by its \`beat\`
// (1-indexed: beat 1 is the top of the loop). Two kinds:
//   - setCode:     \`code\` becomes the sketch — a string ending in .out(o0).
//   - setVariable: \`name\`/\`value\` sets one variable in scope while the sketch
//                  runs (e.g. freq below) — the most-recent value at each
//                  beat wins, same as setCode's code.
// Reference a variable as a FUNCTION — (props) => props.freq — rather than
// the bare name: hydra calls it fresh every frame, so the value tracks the
// table live, during playback, with no recompile/rerun. A bare \`freq\` would
// only ever see the value from when the sketch was compiled.
// Pick variable names that aren't hydra's OWN per-frame fields (time, bpm,
// fps, resolution, speed, stats) — those always win over an injected value
// of the same name, so e.g. naming this variable \`speed\` would silently be
// overridden by hydra's own playback-speed multiplier instead of your data.
//
// The loop is as many beats long as the "beats" control under the scene (16
// by default). So the freq change at beat 9 comes in halfway through the loop
// (the start of the 3rd measure) and stays until the loop wraps. Tap to
// change the tempo (how long a beat lasts); change "beats" to make the loop
// longer/shorter.
//
// editable(name, schema) makes this table live-editable in the table panel —
// it's the ONLY table this sketch needs (named "hydra" so playback reads it
// directly, with no code-generated view in between). Its rows are seeded on
// the right, so the code here carries only the schema — and \`schemas.hydra\`
// is the canonical one (hover it to see the columns): \`event\` and \`mode\`
// come as dropdowns, and \`code\` cells open in this editor with hydra
// completions. The events themselves live in the table: click the code cell
// to open the sketch here; edit a value cell, or "+ row" a new setVariable
// event at a later beat (like the beat-9 setVariable row already seeded)
// right in the table — no code change needed, and any column you add via
// "+ column" survives the next Run too. (Every edit is an event too — see
// the "hydra·events" tab.) A second, code-generated table only becomes
// useful once you need to LAYER computed events on top of these — see
// "House of Cards" for that.
//
// "disabled" is just an ordinary boolean column: check a row's box to mute
// that event — the sketch skips it, as if the row weren't there — without
// losing it; uncheck to bring it back.
editable("hydra", schemas.hydra)
`,
    tables: {
      hydra: [
        { beat: 1, event: "setCode",
          code: "osc((props) => props.freq, 0.1, 1.5).kaleid(5).out(o0)" },
        { beat: 1, event: "setVariable", name: "freq", value: 3 },
        { beat: 9, event: "setVariable", name: "freq", value: 12 },
      ],
    },
  },
  {
    name: "Square + Hydra",
    table: "hydra",
    code: `// livecodata — a flat square spun by three.js, echoed by a two-part hydra sketch
// The square is the plainest possible 3D object: a "box" squashed thin on one
// axis. This example is really about the hydra half — a sketch that changes
// itself partway through the loop, not just a variable (see "Hydra Sketch" for
// that simpler, single-part case). Press "Run" (or Cmd/Ctrl-Enter), then Play.

// 1. One square, spinning a full turn over the 16-beat loop. Two keyframes are
//    enough: ry: 0 at beat 1, ry: 2π at beat 17 (one past the loop's end) — since
//    2π and 0 are the same angle, the spin wraps with no jump when it repeats.
//    A small fixed tilt (rx) keeps the face in view as it turns edge-on to the
//    camera, rather than vanishing to a line.
define("events", () => rows([
  { id: "square", type: "create", beat: 1, shape: "box", color: 0x4a9eff,
    px: 0, py: 0, pz: 0, hx: 0.6, hy: 0.6, hz: 0.05, rx: 0.3, ry: 0, rz: 0 },
  { id: "square", type: "update", beat: 17, ry: Math.PI * 2 },
]))

define("scene", (rand, table) => table("events").rasterize(16))

// 2. A two-part hydra sketch, on the same 16-beat grid as the square's spin
//    above: the first half echoes the rendered scene (src(s0)) with a feedback
//    trail; the second half drops the square entirely for a plain generative
//    pattern, then the loop wraps back to part one. Both are ordinary setCode
//    rows in the SAME editable table — "two-part" just means two of them, each
//    the most-recent code at its point in the loop. Their rows are seeded into
//    the "hydra" tab on the right; the code declares only the canonical
//    schema (hover \`schemas.hydra\` to see its columns).
editable("hydra", schemas.hydra)
`,
    tables: {
      hydra: [
        { beat: 1, event: "setCode",
          code: "src(s0).blend(src(o0).scale(0.97), 0.15).out(o0)" },
        { beat: 9, event: "setCode",
          code: "osc(8, 0.1, 1.2).kaleid(4).color(0.2, 0.6, 1).out(o0)" },
      ],
    },
  },
  {
    name: "Sliders",
    table: "sliders",
    code: `// livecodata — on-screen sliders (the twin of MIDI)
// Sliders are labelled controls drawn over the visual. Press "Run", then Play,
// then drag a slider on the top-left of the scene.

// 1. A table named "sliders" DEFINES them: one row per slider, { id, min, max }
//    (plus an optional \`default\`). Each row becomes a labelled control over the
//    visual. It's an editable() table, seeded on the right with the schema
//    declared here (\`schemas.sliders\`, the canonical slider-table schema —
//    hover it to see the columns) — so open the "sliders" tab in the panel
//    and add a row, rename an id, or change a min/max, then Run to apply.
//    (It could just as well be a computed view: define("sliders", () =>
//    rows([...])).) Check a row's \`disabled\` box to pull that control off
//    the screen without losing its settings — uncheck to bring it back.
editable("sliders", schemas.sliders)

// 2. slider(id) is the sibling of midi(note): a live per-frame value you bind
//    into any field. Here the sphere's height follows the "height" slider —
//    drag it and the orb moves; the value is recorded against playback time and
//    replays every loop (watch the thumb retrace your move). derive leaves a
//    binding resolved each frame, exactly like derive({ amount: midi("c4") }).
define("scene", () =>
  rows([{ id: "orb", type: "create", beat: 1, shape: "sphere", color: 0xffd43b,
          px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }])
    .derive({ py: slider("height") })
    .rasterize(16))

// 3. In a hydra sketch every slider is also on props.sliders, keyed by id — no
//    setVariable rows needed. Reference it as a FUNCTION so hydra reads it fresh
//    each frame: (props) => props.sliders.warp. Here "warp" drives the modulate
//    amount and "brightness" the output level.
define("hydra", () => rows([
  { beat: 1, event: "setCode", code:
    "src(s0).modulate(osc(30), (props) => props.sliders.warp)" +
    ".brightness((props) => props.sliders.brightness - 0.5).out(o0)" },
]))

// Recording & sync: while you're not touching a slider, its recorded automation
// drives the thumb as the loop plays. The moment you grab one it loses sync —
// its old take is cleared and it records anew from the playhead (drag while
// playing to draw a sweep). Slider moves ride the shared session log, so they
// sync to everyone in a room and persist with the session. The raw moves show
// in the "slider·events" tab, the folded current take in "slider".
`,
    tables: {
      sliders: [
        { id: "brightness", min: 0, max: 1,   default: 0.6 },
        { id: "warp",       min: 0, max: 1.5, default: 0.3 },
        { id: "height",     min: -1, max: 1,  default: 0 },
      ],
    },
  },
  {
    name: "Hydra Sketch Swap",
    table: "hydra sketch",
    code: `// livecodata — swapping between two hydra sketches, with a flicker
// See "Hydra Sketch" first for the setCode/setVariable basics. Here the base
// table (\`code\`, below) just swaps scenes with a plain setCode at beat 9 (and
// wraps back at beat 1 when the loop repeats) — the flicker on top of that
// swap is built with \`rotate\` and a new pairing helper, \`pairBy\`. Press "Run"
// (or Cmd/Ctrl-Enter), then hit Play.

// 1. The base sketch: two scenes, swapping with a bare setCode at beat 9. This
//    is the SAME editable table as "Hydra Sketch", just named "hydra sketch"
//    (not "hydra") because we're layering a code-generated transform on top —
//    see \`hydra\`, below, for why the transform, not this table, is what
//    playback actually reads. Its two setCode rows are seeded into the "hydra
//    sketch" tab on the right; the schema is the canonical \`schemas.hydra\`
//    even though the table wears a different name — the schema describes the
//    columns, not the table it's attached to.
editable("hydra sketch", schemas.hydra)

// 2. \`.pairBy({ field: value }, fn)\` finds the rows matching that pattern and
//    cycles through them pairwise: match k is \`second\`, paired with match
//    k-1 as \`first\` — and the LAST match wraps around to pair with the
//    FIRST, so every match gets a partner. fn(first, second) returns the
//    row(s) that replace \`second\`. With two setCode rows that's exactly two
//    pairs: (beat 1 → beat 9), and the wraparound (beat 9 → beat 1).
// 3. \`flicker(n, step)\` is the fn passed to pairBy. \`rotate(rows, values)\`
//    emits one row per \`values\` entry (so \`2*n - 1\` rows here), cycling
//    through the short \`rows\` pattern and merging each value on top:
//    output i = { ...rows[i % rows.length], ...values[i] }. Cycling
//    [second, first] under a run of ascending beats alternates the incoming
//    and outgoing scene — starting AND ending on \`second\` — so the new
//    scene flickers in and out n times before it settles, instead of a
//    hard cut.
const flicker = (n, step) => (first, second) =>
  rotate(
    [second, first],
    Array.from({ length: 2 * n - 1 }, (_, i) => ({ beat: second.beat + i * step })),
  ).rows

define("hydra", (rand, table) =>
  table("hydra sketch").pairBy({ event: "setCode" }, flicker(3, 0.1))
)
`,
    tables: {
      "hydra sketch": [
        { beat: 1, event: "setCode", code: "osc(60, 0.1, 1.5).kaleid(5).out(o0)" },
        { beat: 9, event: "setCode", code: "noise(3, 0.2).colorama(0.5).out(o0)" },
      ],
    },
  },
  {
    name: "Hydra Meta",
    table: "hydra",
    code: `// livecodata — a hydra sketch that rewrites ITSELF as the loop plays
// See "Hydra Sketch" first for setCode/setVariable. On top of those, a hydra
// table has META-PROGRAMMING events — each transforms the code built up so far
// instead of replacing it, so the whole program edits itself on the beat. Press
// "Run" (or Cmd/Ctrl-Enter), then Play, and watch the sketch grow.
//
//   - replace   : swap every occurrence of a literal string (\`find\`) for
//                 \`value\` in the current sketch — no regex, just a substring
//                 swap. Here it retunes the oscillator's frequency mid-loop.
//   - append    : tack a \`.method(...)\` fragment (\`code\`, starting with a dot)
//                 onto the end of the chain, before its .out(). Here it grows a
//                 five-fold kaleidoscope.
//   - setSource : swap the HEAD of the chain — the leading generator — for
//                 \`code\`, keeping the effects after it. Here osc → noise, and
//                 the kaleidoscope from the append carries straight over.
//   - layer      : composite another whole sketch (\`code\`) over the current one
//                 with the hydra blend operator named by \`mode\` — blend / add /
//                 mult (which also take an amount \`value\`) or diff / layer /
//                 mask. Here voronoi is added in over the tail of the loop.
//   - transition : WIPE from the program built up so far (the "before", layers
//                 and all) to the program built up after it over \`value\` beats,
//                 using \`code\` as a MASK: where it's BLACK the before shows,
//                 where it's WHITE the after shows. The mask is YOUR sketch and
//                 you animate it from all-black to all-white across the window —
//                 three names are in scope to drive it: \`transitionStart\` /
//                 \`transitionEnd\` (the window in props.time units) and
//                 \`transitionPos(t)\` (that time as 0→1). Here a gradient ramp
//                 thresholded by transitionPos sweeps in as a directional wipe.
//
// The events fold in beat order onto one running sketch: sampling at any beat
// replays every earlier transform, so the code you see is always the sum of the
// rows up to that point. The \`out\` column names the hydra output a row drives
// (o0 by default) — it's appended as the terminal \`.out(oN)\`, so the setCode
// lines never write their own — and each output folds on its own, so you can
// build a multi-output program (here everything stays on o0). All of it is
// seeded into the "hydra" tab on the right — edit a cell, drag a beat, or
// "+ row" another transform, no code change needed. This just declares the schema.
//
// \`schemas.hydra\` is the canonical schema for this table — hover it to see
// the columns. Three of them are ENUMS: \`event\`, \`mode\`, and \`out\` render
// as dropdowns, so picking a valid one during a set is a click, not a typed
// guess. And because every column is typed, a cell that doesn't fit — a
// misspelled event, text where a number belongs — is flagged red (its row
// too), a quick "this row is wrong" you catch before hitting Run.
editable("hydra", schemas.hydra)
`,
    tables: {
      hydra: [
        // A plain oscillator to start — the sketch every transform below edits.
        // No .out() needed: the `out` column (o0 by default) is appended for you.
        { beat: 1, event: "setCode", code: "osc(20, 0.1, 1.2)" },
        // beat 5: retune it in place — swap the frequency literal 20 → 45.
        { beat: 5, event: "replace", find: "20", value: 45 },
        // beat 7: grow the chain — a five-fold kaleidoscope, before .out().
        { beat: 7, event: "append", code: ".kaleid(5)" },
        // beat 9: swap the source osc → noise; the kaleidoscope stays put.
        { beat: 9, event: "setSource", code: "noise(2.5, 0.3)" },
        // beat 13: add a voronoi field in over the current sketch (mode "add",
        // amount 0.5) — a different compositor than a plain crossfade.
        { beat: 13, event: "layer", code: "voronoi(10)", mode: "add", value: 0.5 },
        // beat 14: WIPE to a fresh program over 2 beats. `transition` snapshots
        // everything so far (noise + kaleid + voronoi) as the "before"; `code`
        // is the mask YOU animate black→white across the window. Here a static
        // gradient ramp is thresholded by transitionPos, so the threshold sweeps
        // 1→0 and the ramp fills in white left→right — a directional wipe. Swap
        // the mask for a dissolve, an iris, anything that goes black→white.
        { beat: 14, event: "transition", code: "gradient(0).thresh((props) => 1 - transitionPos(props.time), 0.15)", value: 2 },
        // beat 14 (right after the transition): the destination it reveals — a
        // brand-new sketch that the wipe crosses over to by beat 16.
        { beat: 14, event: "setCode", code: "osc(30, 0.2, 2).kaleid(7)" },
      ],
    },
  },
  {
    name: "Bauble Sketch",
    code: `// livecodata — a 3D SDF sketch with bauble (ianthehenry's bauble.studio)
// Where hydra post-processes 2D textures, bauble raymarches a 3D scene written
// in Janet — shapes composed as signed distance functions and compiled to a
// GLSL shader. No 3D scene or hydra table involved: the bauble render shows
// directly. Press "Run" (or Cmd/Ctrl-Enter), then hit Play.
//
// The bauble table is the same event format as the hydra one — rows placed on
// the loop by \`beat\` (1-indexed: beat 1 is the top of the loop), two kinds:
//   - setCode:     \`code\` becomes the sketch — a Janet shape expression like
//                  "(union (box 60) (sphere 75))". \`t\` is the playback clock
//                  in seconds, so pausing/scrubbing the timeline freezes/
//                  scrubs the raymarch too. The dialect is bauble.studio's:
//                  box/sphere/torus/cone…, union/intersect/subtract (\`:r\` for
//                  smooth blends), rotate/move/scale, twist/bend/morph,
//                  shade/color and friends.
//   - setVariable: \`name\`/\`value\` binds a variable the sketch reads — it's
//                  compiled in as \`(def name value)\` ahead of the code. A
//                  string value is any Janet expression: value "(sin t)" makes
//                  the variable a live wave. NOTE the difference from hydra:
//                  hydra reads variables per frame through props with no
//                  recompile, but bauble BAKES them into the shader — each
//                  change recompiles the sketch. Changing on the beat grid
//                  (like size at beat 9 below) is exactly what that's for;
//                  just don't drive one from something that sweeps every frame.
//
// The exception is the camera: "camera-x" / "camera-y" (orbit, in turns of a
// full revolution) and "camera-zoom" (distance multiplier, 1 = default) are
// reserved names the renderer consumes as live uniforms — never compiled in —
// so a camera move costs nothing. The beat-5 row below steps the orbit around
// the scene with no recompile at all.
//
// The rows are seeded into the "bauble" tab on the right — the code here
// declares only the schema, and \`schemas.bauble\` is the canonical one (hover
// it to see the columns). \`event\` is a dropdown; \`code\` cells open in this
// editor as Janet (each row's ⓘ shows the full compiled script, defs
// included); check \`disabled\` to mute a row without deleting it.
//
// Want to post-process the raymarch? The bauble render is also hydra's s1
// source — add a hydra table reading src(s1) and its output takes over the
// display: try
//   editable("hydra", schemas.hydra)
// with a row { beat: 1, event: "setCode", code: "src(s1).kaleid(3)" }.
editable("bauble", schemas.bauble)
`,
    tables: {
      bauble: [
        // A box spinning inside a sphere, smoothly blended (:r 15) and shaded
        // blue. \`size\` and \`t\` are free in the code — size comes from the
        // setVariable rows, t is the playback clock.
        { beat: 1, event: "setCode",
          code: "(shade (union :r 15 (rotate (box size) :y t) (sphere 70)) [0.29 0.62 1])" },
        { beat: 1, event: "setVariable", name: "size", value: 55 },
        // beat 5: orbit the camera a third of a turn — a live uniform, no
        // recompile (camera-x tilts, camera-zoom dollies, the same way).
        { beat: 5, event: "setVariable", name: "camera-y", value: 0.35 },
        // beat 9: grow the box through the sphere — a (def size …) change,
        // so this one recompiles the sketch, right on the beat.
        { beat: 9, event: "setVariable", name: "size", value: 85 },
        // beat 13: a new sketch for the loop's tail — a golden box twisting
        // back and forth on its y axis until the loop wraps.
        { beat: 13, event: "setCode",
          code: "(shade (twist (box 70) :y (* 0.03 (sin t))) [1 0.83 0.23])" },
      ],
    },
  },
  {
    name: "House of Cards",
    table: "ball_height",
    code: `// livecodata — House of Cards
// A triangular pyramid of playing cards collapses when a ball drops on it.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.
// Tips: Ctrl-Space completes views, Table verbs, and Expr methods (the methods
// after field()/lit()/idx() — e.g. field("v").add(1).gt(2)); hover a "view" name
// to preview its table; your caret selects that view's tab on the right.

// 1. Build a 3-story pyramid of cards plus a ball held above it.
//    Story k has (n − k) leaning-card tent pairs and (n − k − 1) horizontal
//    bridge cards between them. Card positions are derived analytically from the
//    lean angle so each card's lowest rotated corner rests on its support
//    surface — the pyramid starts at rest, no settling wobble. The ball's
//    \`dropAt: 2\` holds it motionless in the air for the first 2 seconds of
//    sim time, then releases it into ordinary free fall.
define("base", () => {
  const lean = 0.25                    // radians from vertical (~14°)
  const H = 0.35, W = 0.22, T = 0.005  // card half-height, half-width, half-thickness
  const sl = Math.sin(lean), cl = Math.cos(lean)
  const dx    = H * sl                 // card-center x offset from tent apex
  const cyOff = T * sl + H * cl       // support-surface to card-center (no corner overlap)
  const S     = 0.50                   // spacing between adjacent tent apices
  const n     = 3                      // tents on the ground floor (try 4 for ~27 cards)

  const cards = []
  let supportY = -1.0                  // current support surface y (floor to start)

  for (let k = 0; k < n; k++) {
    const numTents = n - k
    const cardCY   = supportY + cyOff
    const topY     = supportY + T * sl + 2 * H * cl  // tent apex y
    const bHx      = S / 2 + 0.03                    // bridge half-span

    // Leaning card pairs — two cards per tent, tops meeting at the apex
    for (let i = 0; i < numTents; i++) {
      const tx = -(numTents - 1) * S / 2 + i * S     // apex x
      cards.push(
        { id: "s" + k + "t" + i + "a", type: "create", shape: "box", color: 0xfdf6e3,
          motion: "dynamic", friction: 0.3, restitution: 0,
          px: tx - dx, py: cardCY, pz: 0, hx: T, hy: H, hz: W, rz: -lean },
        { id: "s" + k + "t" + i + "b", type: "create", shape: "box", color: 0xfdf6e3,
          motion: "dynamic", friction: 0.3, restitution: 0,
          px: tx + dx, py: cardCY, pz: 0, hx: T, hy: H, hz: W, rz:  lean },
      )
    }

    // Horizontal bridge cards spanning adjacent tent apices
    for (let i = 0; i < numTents - 1; i++) {
      const bx = -(numTents - 1) * S / 2 + (i + 0.5) * S
      cards.push(
        { id: "s" + k + "b" + i, type: "create", shape: "box", color: 0xe74c3c,
          motion: "dynamic", friction: 0.3, restitution: 0,
          px: bx, py: topY + T, pz: 0, hx: bHx, hy: T, hz: W },
      )
    }

    // Crown on the top-story apex (replaces bridges on the final story)
    if (k === n - 1) {
      cards.push(
        { id: "crown", type: "create", shape: "box", color: 0xe74c3c,
          motion: "dynamic", friction: 0.3, restitution: 0,
          px: 0, py: topY + T, pz: 0, hx: bHx, hy: T, hz: W },
      )
    }

    supportY = topY + 2 * T  // bridge top surface becomes next story's floor
  }

  return rows([
    { id: "floor", type: "create", shape: "box", color: 0x1a2e1a,
      motion: "static", px: 0, py: -1.2, pz: 0, hx: 4, hy: 0.2, hz: 4 },
    { id: "ball",  type: "create", shape: "sphere", color: 0xf39c12,
      motion: "dynamic", restitution: 0.2, r: 0.12, dropAt: 2,
      px: 0.05, py: 2.0, pz: 0 },
    ...cards,
  ])
})

// 2. Bake a JoltPhysics simulation in the background: step the world for 360
//    frames (12 beats at the fixed 30-frames-per-beat grid). simulate() ADDS to
//    the table — a per-frame "update" row for each moving body (\`beat\`, in
//    beats; the cache interpolates between them) plus a "collision" row whenever
//    two bodies first touch. Physics runs in real seconds internally and lands
//    its output on the beat grid, so a collision at beat 4 always sits at beat 4.
//    The 3rd arg tags this view into the "events" group: the engine auto-builds
//    a view named "events" that concats every group member (beat-sorted), so
//    multiple simulation views would merge into one "events" table — no manual
//    .concat. "events" is the single sparse stream of object motion + collisions.
define("sim", "events", (rand, table) =>
  physics(table("base")).simulate({ steps: 360, gravity: -9.81 })
)

// 3. Bake the sparse "events" stream into a dense per-frame cache for playback
//    (12 beats — the full simulation).
define("scene", (rand, table) => table("events").rasterize(12))

// 4. Collisions are just rows — pull them into their own view to inspect, and
//    graph the ball's height over time as it bounces and settles.
define("collisions", (rand, table) =>
  table("events").filter({ type: "collision" })
)

define("ball_height", (rand, table) =>
  table("events")
    .filter({ id: "ball", type: "update" })
    .map(r => ({ beat: r.beat, height: r.py }))
    .graph("height")
)

// 5. Beat-synced looping (optional). Tap the Tap button under the scene a few
//    times to set the tempo; the timeline's wall-clock length then follows it —
//    tap faster and the whole loop plays faster. "Loop" (next to Play) is on by
//    default. beats(16) loops every 16 beats; { fit: 12 } stretches this 12-beat
//    sim across the window so it plays once per loop:
//
// define("timeline", () => beats(16, { fit: 12 }))
`,
  },
  {
    name: "CO2 (Mauna Loa)",
    table: "co2_monthly",
    code: `// Mauna Loa CO2 — monthly atmospheric measurements by NOAA/Scripps, 1958–2026.
// The seasonal swing (~6 ppm) reflects northern-hemisphere plant growth;
// the long-run rise tracks fossil-fuel emissions.
// Source: github.com/datasets/co2-ppm (NOAA GML)

define("co2", () => data("/data/co2.csv"))

// Monthly readings — the seasonal sawtooth is clearly visible
define("co2_monthly", (rand, table) => table("co2").graph("co2_ppm"))

// Annual mean: group monthly rows by year, average the ppm readings
define("co2_annual", (rand, table) =>
  table("co2")
    .derive({ year: r => +r.date.slice(0, 4) })
    .groupBy("year")
    .agg({ year: rs => rs[0].year, co2_ppm: rs => +(rs.reduce((s, r) => s + r.co2_ppm, 0) / rs.length).toFixed(2) })
    .graph("co2_ppm")
)`,
  },
  {
    name: "Global temperature",
    table: "temp_chart",
    code: `// Global surface temperature anomaly — GCAG dataset, 1850–2026.
// Values are mean °C deviation from the 1901–2000 baseline.
// The sharp uptick from ~1980 is the clearest signal of anthropogenic warming.
// Source: github.com/datasets/global-temp (GCAG / NOAA)

define("temp", () => data("/data/global-temp.csv"))

// Temperature anomaly over time — negative = cooler than baseline, positive = warmer
define("temp_chart", (rand, table) => table("temp").graph("mean"))

// Running 10-year mean to smooth inter-annual variability
define("temp_smooth", (rand, table) =>
  table("temp")
    .scan([], (window, r) => {
      window = [...window.slice(-9), r.mean]
      return { year: r.year, mean: r.mean, avg10: +(window.reduce((s, v) => s + v, 0) / window.length).toFixed(4) }
    })
    .graph("mean", "avg10")
)`,
  },
  {
    name: "HadCRUT5 (global)",
    table: "anomaly_monthly",
    code: `// HadCRUT5 global surface temperature anomaly — Met Office / CRU, monthly 1850–present.
// Values are °C deviation from the 1961–1990 baseline with 95 % confidence bounds.
// Run \`npm run fetch-data\` once to download src/data/hadcrut5-monthly.csv.
// Source: Met Office HadOBS (HadCRUT.5.1.0.0)

define("hadcrut5", () => data("/data/hadcrut5-monthly.csv"))

// Monthly anomaly with confidence ribbon
define("anomaly_monthly", (rand, table) =>
  table("hadcrut5")
    .map(r => ({ ...r, anomaly_c: +r.anomaly_c, lower_ci: +r.lower_ci, upper_ci: +r.upper_ci }))
    .graph("anomaly_c", "lower_ci", "upper_ci")
)

// Annual mean anomaly
define("anomaly_annual", (rand, table) =>
  table("hadcrut5")
    .derive({ year: r => r.year_month.slice(0, 4), anomaly_c: r => +r.anomaly_c })
    .groupBy("year")
    .agg({ year: rs => rs[0].year, anomaly_c: rs => +(rs.reduce((s, r) => s + r.anomaly_c, 0) / rs.length).toFixed(4) })
    .graph("anomaly_c")
)`,
  },
]
