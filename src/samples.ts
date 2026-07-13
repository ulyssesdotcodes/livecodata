// Sample programs for the livecodata editor. CSV datasets are served from
// /data/ and loaded at run time via data(url) — no inline embedding needed.
export const SAMPLES = [
  {
    name: "Editable Table",
    code: `// livecodata — a sphere moved by an editable table
// Unlike every other example here, the path below isn't computed by code —
// it's data you edit directly, live, in the table panel on the right.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. editable(name, schema, seedRows?) declares a user-editable table: rows
//    are entered/edited in the table panel (its own "path" tab), not
//    computed — edits persist across runs, unlike a normal view. Each keyframe
//    sits on a beat (1-indexed: beat 1 is the top of the loop). Try it: open
//    the "path" tab, click a cell to change a coordinate, or hit "+ row" to
//    add a keyframe, then press Run again to see the sphere follow the new
//    path. (Every edit is recorded as an event too — see the "path·events" tab.)
define("path", () =>
  editable("path", { beat: "number", px: "number", py: "number", pz: "number" }, [
    { beat: 1, px: -1, py: 0,   pz: 0 },
    { beat: 3, px: 1,  py: 1,   pz: 0 },
    { beat: 5, px: 0,  py: 0.3, pz: -1 },
  ])
)

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
  },
  {
    name: "Origami Crane",
    code: `// livecodata — Origami Crane, part 1: square base, then the petal fold
// A square of paper folds itself from a STATIC TABLE OF CREASES: every row
// is one crease, given outright — no folded-model bookkeeping, nothing
// inferred. Press "Run" (or Cmd/Ctrl-Enter), then hit Play.
//
// The table ("steps" in the table panel):
//   step    the fold's name. Rows sharing a name are one fold whose crease
//           runs through several layers; rows with no p1/p2 re-drive it
//           (keyframes along a collapse's path)
//   p1,p2   the crease: each point is "edge@t" — a fraction along an edge
//           of the ORIGINAL square (bottom/top run left→right, left/right
//           bottom→top) — or "name@t", a fraction along an earlier row's
//           segment. Every point is built from the sheet's boundary and
//           the folds before it, the way origami constructions work (raw
//           "x,y" is also accepted)
//   move    sample points ("x,y", ";"-separated) inside the pieces this
//           crease rotates — only pieces TOUCHING it; everything attached
//           rides along through the hinge tree. A row with a line but NO
//           move is a CONSTRUCTION line: it cuts and folds nothing, and
//           exists to be referenced
//   sign    which way this crease turns for positive fractions (flipping
//           it = swapping p1/p2). Layers of a stack often need opposite
//           senses — that is what makes a collapse work at all; if a flap
//           tears away mid-fold, flip its crease's sign
//   deg     the fold's full signed angle (±180 = flat)
//   at,dur,to  timing, and how far to drive (1 folded, 0 open, −1 folded
//           the other way; a row with dur 0 is geometry only)
// Fractions are per STEP, so driving "s1" moves its crease on every layer
// at once; the player hinges faces about the material crease lines and
// WELDS shared points, so an impossible pose reads as paper strain, never
// a tear. (Nothing checks fold-through-ability yet — that's planned.)
//
// THE SQUARE BASE (beats 1–14.5): fold the triangle (the diagonal written
// as two steps, "spine" and "still", so the collapse can drive its halves
// apart), then squash around the middle — "s1" and the halving valley
// "hv" rise as the pocket while the spine opens — press flat right, the
// same on the other side ("s2"), press left: the classic base, POINT DOWN.
//
// THE PETAL FOLD (beats 14.6–16, instructables crane steps 7 and 8): a
// valley across the front face between (−0.586,0) and (0,0.586) — √2−1
// along each top edge, exactly where the bottom edges land if folded to
// the centre line — and mountains from those points to the bottom corner
// ("kite"/"kite2"). The flap lifts with its wings flat while the "peel"
// steps open the front layer's ridge creases with it (they lie on the
// valley, so the lift unfolds them exactly; the back's stay pressed);
// near the end the wings SNAP over — the kite mountains flip and press
// the side corners onto the centre line in one quick pop, the way real
// paper gives (the petal fold is famously not rigid-foldable, and this
// snap path is the strain-solved way through). These are SINGLE folds:
// the back face doesn't move until its own petal, from the back corner,
// repeats the same lines ("kite3"/"kite4"/"petal2").
//
// THINNING THE LEGS (beats 16.5–17.7, crane steps 9–10): fold the bird
// base's lower edges onto the centre line, front pair then back pair.
// One fold line per edge, but it pierces FIVE plies, so each fold is a
// chain of five creases turning at the peel, valley and squash lines —
// the creases were sliced ply-by-ply off the folded model, and the
// Kawasaki/Maekawa check passes at every vertex of the chain.
//
// NECK AND TAIL (beats 18.6–20.6, crane steps 11–12): INSIDE REVERSE
// folds swing each thinned point up through its own layers. The point's
// lengthwise folds — spine/still outer halves, kite and thin outer
// segments, split at the reverse line — flip sign as it passes: first
// the POP (the point swings about its own axis line, a nearly free
// hinge), then the PRESS (the reverse crease folds flat). The neck's
// reverse line is steeper (60° above the wing line, vs 30° for the
// tail) so the head end rises higher, as on the real bird. Every fold
// ends FLAT: square base, each petal, the exact bird base, each
// thinning pass, each reverse fold — and the flat-fold theorems hold at
// every vertex, which is what catches a reverse fold done the illegal
// way (folding outside instead of through).

define("steps", () => {
  // keyframes shared by every layer of a crease: [at, dur, to]
  const kf = (steps, tl) => steps.flatMap((step) =>
    tl.map(([at, dur, to]) => ({ step, at, dur, to })))
  return editable("steps", {
    step: "string", p1: "string", p2: "string", move: "string",
    sign: "number", deg: "number", at: "number", dur: "number", to: "number",
  }, [
    // ── construction lines (no move: nothing folds; they exist so later
    //    rows can reference points along them, "name@t") ──
    // the main diagonal, and the two medians the petal points sit on
    { step: "diag", p1: "bottom@0", p2: "top@1" },
    { step: "vm", p1: "bottom@0.5", p2: "top@0.5" },
    { step: "hm", p1: "left@0.5", p2: "right@0.5" },
    // ── the creases: every fold built from the sheet's edges and the
    //    folds before it ──
    // the triangle fold: the diagonal, in two drivable halves
    // (each written in TWO drivable pieces, split where the neck and tail
    // reverse folds will cross — the outer halves flip then)
    { step: "spine", p1: "diag@0.5", p2: "0.2928932188,0.2928932188", move: "0.5286,0.3333", sign: 1, deg: 180, at: 1, dur: 2, to: 1 },
    { step: "spineN", p1: "0.2928932188,0.2928932188", p2: "0.7522961665,0.7522961665", move: "0.5286,0.3333", sign: 1, deg: 180, at: 1, dur: 2, to: 1 },
    { step: "spineH", p1: "0.7522961665,0.7522961665", p2: "diag@1", move: "0.5286,0.3333", sign: 1, deg: 180, at: 1, dur: 2, to: 1 },
    { step: "still", p1: "-0.2928932188,-0.2928932188", p2: "diag@0.5", move: "-0.3333,-0.5286", sign: 1, deg: 180, at: 1, dur: 2, to: 1 },
    { step: "stillN", p1: "diag@0", p2: "-0.2928932188,-0.2928932188", move: "-0.3333,-0.5286", sign: 1, deg: 180, at: 1, dur: 2, to: 1 },
    // the squash folds, one crease per layer — the petal points sit 2−√2
    // along each median from the centre (vm/hm @ 0.7928… and 0.2071…)
    { step: "s1", p1: "vm@0.7928932188", p2: "diag@0.5", move: "0.3333,0.5286", sign: 1, deg: 180, at: 4, dur: 0.5, to: -0.18 },
    { step: "s1", p1: "hm@0.7928932188", p2: "diag@0.5", move: "0.5286,0.3333", sign: -1 },
    { step: "hv", p1: "bottom@1", p2: "diag@0.5", move: "0.2929,-0.0976", sign: -1, deg: 90, at: 4, dur: 0.5, to: 0.248 },
    { step: "s2", p1: "hm@0.2071067812", p2: "diag@0.5", move: "-0.5286,-0.3333", sign: 1, deg: -180, at: 9.5, dur: 0.25, to: -0.125 },
    { step: "s2", p1: "vm@0.2071067812", p2: "diag@0.5", move: "-0.3333,-0.5286", sign: -1 },
    // the petal fold, front: the valley between the squash folds' ends
    // lifts the flap while the ridge peels open with it; the kite
    // mountains (corners to those same ends) snap over near the end, in
    // ONE cache frame, so the pop's strained instant (the famous
    // non-rigid moment) lands between rendered frames — max rendered
    // flex 0.16, vs 0.51 when the kites moved in lockstep with the valley
    { step: "kite", p1: "top@0", p2: "s2@0", move: "-0.8619,0.3333", sign: 1, deg: -180, at: 14.9333, dur: 0.0333, to: 1 },
    { step: "kite", p1: "-0.617298121,-0.0760759335", p2: "s2@0", move: "-0.8619,-0.3333", sign: -1 },
    { step: "kiteN", p1: "bottom@0", p2: "-0.617298121,-0.0760759335", move: "-0.8619,-0.3333", sign: -1, deg: -180, at: 14.9333, dur: 0.0333, to: 1 },
    { step: "kite2", p1: "0.0760759335,0.617298121", p2: "s1@0", move: "0.3333,0.8619", sign: -1, deg: 180, at: 14.9333, dur: 0.0333, to: 1 },
    { step: "kite2", p1: "top@0", p2: "s1@0", move: "-0.3333,0.8619", sign: 1 },
    { step: "kite2H", p1: "top@1", p2: "0.6765031023,0.8660031976", move: "0.3333,0.8619", sign: -1, deg: 180, at: 14.9333, dur: 0.0333, to: 1 },
    { step: "kite2N", p1: "0.6765031023,0.8660031976", p2: "0.0760759335,0.617298121", move: "0.3333,0.8619", sign: -1, deg: 180, at: 14.9333, dur: 0.0333, to: 1 },
    { step: "petal", p1: "s2@0", p2: "s1@0", move: "-0.5286,0.5286", sign: 1, deg: 180, at: 14.6, dur: 0.65, to: 1 },
    { step: "peelfr", p1: "top@0.5", p2: "s1@0", move: "0.3333,0.8619", sign: 1, deg: 180, at: 4, dur: 0.5, to: -0.18 },
    { step: "peelfl", p1: "left@0.5", p2: "s2@0", move: "-0.8619,-0.3333", sign: 1, deg: -180, at: 9.5, dur: 0.25, to: -0.125 },
    // the petal fold, back: the same lines from the back corner
    { step: "kite3", p1: "-0.076132636,-0.617321608", p2: "vm@0.2071067812", move: "-0.3333,-0.8619", sign: 1, deg: -180, at: 15.7, dur: 0.0333, to: 1 },
    { step: "kite3", p1: "bottom@1", p2: "vm@0.2071067812", move: "0.3333,-0.8619", sign: -1 },
    { step: "kite3N", p1: "bottom@0", p2: "-0.076132636,-0.617321608", move: "-0.3333,-0.8619", sign: 1, deg: -180, at: 15.7, dur: 0.0333, to: 1 },
    { step: "kite4", p1: "bottom@1", p2: "hm@0.7928932188", move: "0.8619,-0.3333", sign: -1, deg: 180, at: 15.7, dur: 0.0333, to: 1 },
    { step: "kite4", p1: "0.617321608,0.076132636", p2: "hm@0.7928932188", move: "0.8619,0.3333", sign: 1 },
    { step: "kite4H", p1: "top@1", p2: "0.8660031976,0.6765031023", move: "0.8619,0.3333", sign: 1, deg: 180, at: 15.7, dur: 0.0333, to: 1 },
    { step: "kite4N", p1: "0.8660031976,0.6765031023", p2: "0.617321608,0.076132636", move: "0.8619,0.3333", sign: 1, deg: 180, at: 15.7, dur: 0.0333, to: 1 },
    { step: "petal2", p1: "vm@0.2071067812", p2: "hm@0.7928932188", move: "0.4310,-0.6262;0.6262,-0.4310", sign: -1, deg: 180, at: 15.35, dur: 0.65, to: 1 },
    { step: "peelbr", p1: "right@0.5", p2: "hm@0.7928932188", move: "0.8619,0.3333", sign: -1, deg: 180, at: 4, dur: 0.5, to: -0.18 },
    { step: "peelbl", p1: "bottom@0.5", p2: "vm@0.2071067812", move: "-0.3333,-0.8619", sign: -1, deg: -180, at: 9.5, dur: 0.25, to: -0.125 },
    // thin the legs (crane steps 9-10): fold the bird base's lower edges
    // onto the centre line, front pair then back pair. ONE fold line per
    // edge — but the line pierces five plies, turning at the peel, the
    // petal valley and the squash crease, so each fold is a CHAIN of five
    // creases (sliced ply by ply off the folded model; the extra folded
    // triangles past the valley hide under the wings, as on real paper)
    { step: "thinfr", p1: "0.4262703879,0.8858851802", p2: "0,0.8011", move: "0.5059,0.8711", sign: 1, deg: 180, at: 16.5, dur: 0.5, to: 1 },
    { step: "thinfr", p1: "0,0.8011", p2: "-0.3512,0.7312", move: "-0.1697,0.7367", sign: 1 },
    { step: "thinfr", p1: "-0.1522,0.4335", p2: "-0.3512,0.7312", move: "-0.2268,0.5991", sign: 1 },
    { step: "thinfr", p1: "-0.1522,0.4335", p2: "0,0.3318", move: "-0.0595,0.4076", sign: 1 },
    { step: "thinfr", p1: "0.5135980841,0.6749862398", p2: "0,0.3318", move: "0.4833,0.6909", sign: 1 },
    { step: "thinfrH", p1: "1,1", p2: "0.5271354908,0.9059472492", move: "0.5059,0.8711", sign: 1, deg: 180, at: 16.5, dur: 0.5, to: 1 },
    { step: "thinfrN", p1: "0.5271354908,0.9059472492", p2: "0.4262703879,0.8858851802", move: "0.5059,0.8711", sign: 1, deg: 180, at: 16.5, dur: 0.5, to: 1 },
    { step: "thinfrH", p1: "1,1", p2: "0.5992516924,0.7322199809", move: "0.4833,0.6909", sign: 1 },
    { step: "thinfrN", p1: "0.5992516924,0.7322199809", p2: "0.5135980841,0.6749862398", move: "0.4833,0.6909", sign: 1 },
    { step: "thinfl", p1: "-0.2562347721,-0.8520650962", p2: "0,-0.8011", move: "-0.4942,-0.93", sign: 1, deg: 180, at: 16.5, dur: 0.5, to: 1 },
    { step: "thinfl", p1: "0,-0.8011", p2: "0.3512,-0.7312", move: "0.1814,-0.7956", sign: 1 },
    { step: "thinfl", p1: "0.1522,-0.4335", p2: "0.3512,-0.7312", move: "0.2766,-0.5657", sign: 1 },
    { step: "thinfl", p1: "0.1522,-0.4335", p2: "0,-0.3318", move: "0.0928,-0.3577", sign: 1 },
    { step: "thinfl", p1: "-0.3694922085,-0.5786946937", p2: "0,-0.3318", move: "-0.5167,-0.641", sign: 1 },
    { step: "thinflN", p1: "-1,-1", p2: "-0.2562347721,-0.8520650962", move: "-0.4942,-0.93", sign: 1, deg: 180, at: 16.5, dur: 0.5, to: 1 },
    { step: "thinflN", p1: "-1,-1", p2: "-0.3694922085,-0.5786946937", move: "-0.5167,-0.641", sign: 1 },
    { step: "thinbr", p1: "0.8858720784,0.4262045167", p2: "0.8011,0", move: "0.93,0.4942", sign: -1, deg: 180, at: 17.2, dur: 0.5, to: 1 },
    { step: "thinbr", p1: "0.8011,0", p2: "0.7312,-0.3512", move: "0.7956,-0.1814", sign: -1 },
    { step: "thinbr", p1: "0.4335,-0.1522", p2: "0.7312,-0.3512", move: "0.5657,-0.2766", sign: -1 },
    { step: "thinbr", p1: "0.4335,-0.1522", p2: "0.3318,0", move: "0.3577,-0.0928", sign: -1 },
    { step: "thinbr", p1: "0.6749995558,0.5136180123", p2: "0.3318,0", move: "0.641,0.5167", sign: -1 },
    { step: "thinbrH", p1: "1,1", p2: "0.9059472491,0.5271354908", move: "0.93,0.4942", sign: -1, deg: 180, at: 17.2, dur: 0.5, to: 1 },
    { step: "thinbrN", p1: "0.9059472491,0.5271354908", p2: "0.8858720784,0.4262045167", move: "0.93,0.4942", sign: -1, deg: 180, at: 17.2, dur: 0.5, to: 1 },
    { step: "thinbrH", p1: "1,1", p2: "0.7322199809,0.5992516924", move: "0.641,0.5167", sign: -1 },
    { step: "thinbrN", p1: "0.7322199809,0.5992516924", p2: "0.6749995558,0.5136180123", move: "0.641,0.5167", sign: -1 },
    { step: "thinbl", p1: "-0.8520669717,-0.2562442014", p2: "-0.8011,0", move: "-0.93,-0.4942", sign: -1, deg: 180, at: 17.2, dur: 0.5, to: 1 },
    { step: "thinbl", p1: "-0.8011,0", p2: "-0.7312,0.3512", move: "-0.7956,0.1814", sign: -1 },
    { step: "thinbl", p1: "-0.4335,0.1522", p2: "-0.7312,0.3512", move: "-0.5657,0.2766", sign: -1 },
    { step: "thinbl", p1: "-0.4335,0.1522", p2: "-0.3318,0", move: "-0.3577,0.0928", sign: -1 },
    { step: "thinbl", p1: "-0.5786871669,-0.3694809441", p2: "-0.3318,0", move: "-0.641,-0.5167", sign: -1 },
    { step: "thinblN", p1: "-1,-1", p2: "-0.8520669717,-0.2562442014", move: "-0.93,-0.4942", sign: -1, deg: 180, at: 17.2, dur: 0.5, to: 1 },
    { step: "thinblN", p1: "-1,-1", p2: "-0.5786871669,-0.3694809441", move: "-0.641,-0.5167", sign: -1 },
    // the neck and tail (crane steps 11-12): INSIDE REVERSE FOLDS swing
    // each thinned point up through its own layers. One reverse line per
    // point, sliced through its eight plies (the chain turns at the peel,
    // kite and squash lines); the point's lengthwise folds — the split-off
    // "N" halves of spine/still, the kites, and the thin chains — flip
    // sign beyond the line, driven by the reversal keyframes below
    { step: "neck", p1: "0.2928932188,0.2928932188", p2: "0.5135980841,0.6749862398", move: "0.429327,0.46903", sign: -1, deg: 180, at: 18.87, dur: 0.63, to: 1 },
    { step: "neck", p1: "0.0760759335,0.617298121", p2: "0.5135980841,0.6749862398", move: "0.2909,0.67588", sign: 1 },
    { step: "neck", p1: "0.0760759335,0.617298121", p2: "0.4262703879,0.8858851802", move: "0.269417,0.727784", sign: -1 },
    { step: "neck", p1: "top@0.5", p2: "0.4262703879,0.8858851802", move: "0.220903,0.971922", sign: 1 },
    { step: "neck", p1: "0.2928932188,0.2928932188", p2: "0.6749995558,0.5136180123", move: "0.469037,0.429334", sign: 1 },
    { step: "neck", p1: "0.617321608,0.076132636", p2: "0.6749995558,0.5136180123", move: "0.675911,0.290976", sign: -1 },
    { step: "neck", p1: "0.617321608,0.076132636", p2: "0.8858720784,0.4262045167", move: "0.727795,0.269449", sign: 1 },
    { step: "neck", p1: "right@0.5", p2: "0.8858720784,0.4262045167", move: "0.971912,0.220865", sign: -1 },
    { step: "tail", p1: "-0.2928932188,-0.2928932188", p2: "-0.5786871669,-0.3694809441", move: "-0.428044,-0.360186", sign: 1, deg: 180, at: 19.97, dur: 0.63, to: 1 },
    { step: "tail", p1: "-0.617298121,-0.0760759335", p2: "-0.5786871669,-0.3694809441", move: "-0.627736,-0.226693", sign: -1 },
    { step: "tail", p1: "-0.617298121,-0.0760759335", p2: "-0.8520669717,-0.2562442014", move: "-0.716419,-0.189959", sign: 1 },
    { step: "tail", p1: "left@0.5", p2: "-0.8520669717,-0.2562442014", move: "-0.952014,-0.143121", sign: -1 },
    { step: "tail", p1: "-0.2928932188,-0.2928932188", p2: "-0.3694922085,-0.5786946937", move: "-0.360191,-0.428049", sign: -1 },
    { step: "tail", p1: "-0.076132636,-0.617321608", p2: "-0.3694922085,-0.5786946937", move: "-0.226729,-0.627753", sign: 1 },
    { step: "tail", p1: "-0.076132636,-0.617321608", p2: "-0.2562347721,-0.8520650962", move: "-0.189986,-0.716426", sign: -1 },
    { step: "tail", p1: "bottom@0.5", p2: "-0.2562347721,-0.8520650962", move: "-0.143116,-0.952011", sign: 1 },
    // the head (crane step 12): one more inside reverse fold at the neck's
    // tip — the neck's lengthwise halves split AGAIN ("H" steps) and flip
    { step: "head", p1: "0.5992516924,0.7322199809", p2: "0.7522961665,0.7522961665", move: "0.671852,0.771992", sign: -1, deg: 180, at: 21.07, dur: 0.5, to: 1 },
    { step: "head", p1: "0.5992516924,0.7322199809", p2: "0.6765031023,0.8660031976", move: "0.663779,0.78408", sign: 1 },
    { step: "head", p1: "0.5271354908,0.9059472492", p2: "0.6765031023,0.8660031976", move: "0.609565,0.914928", sign: -1 },
    { step: "head", p1: "0.5271354908,0.9059472492", p2: "0.649695038,1", move: "0.606727,0.929191", sign: 1 },
    { step: "head", p1: "0.7322199809,0.5992516924", p2: "0.7522961665,0.7522961665", move: "0.771987,0.67185", sign: 1 },
    { step: "head", p1: "0.7322199809,0.5992516924", p2: "0.8660031976,0.6765031023", move: "0.784077,0.663772", sign: -1 },
    { step: "head", p1: "0.9059472491,0.5271354908", p2: "0.8660031976,0.6765031023", move: "0.914941,0.609589", sign: 1 },
    { step: "head", p1: "0.9059472491,0.5271354908", p2: "1,0.649695038", move: "0.929189,0.606755", sign: -1 },
    // the wings fold down (crane step 13), a quarter turn about the
    // shoulder line — each wing is its flap's three plies (panel + wraps)
    { step: "wingf", p1: "-0.0230091937,0.5953171577", p2: "-0.0999893356,0.7811989335", move: "-0.089216,0.676776", sign: -1, deg: -90, at: 21.8, dur: 0.8, to: 1 },
    { step: "wingf", p1: "-0.1000026298,1", p2: "-0.0999918502,0.781198433", move: "-0.129997,0.890598", sign: 1 },
    { step: "wingf", p1: "-0.5183163294,0.2088961692", p2: "-0.595318401,0.0230121952", move: "-0.58453,0.127441", sign: 1 },
    { step: "wingf", p1: "-0.5183163294,0.2088961692", p2: "-0.2088896014,0.5183065042", move: "-0.384815,0.384818", sign: -1 },
    { step: "wingf", p1: "-0.0230079538,0.5953166441", p2: "-0.2088904689,0.518307802", move: "-0.127437,0.584525", sign: 1 },
    { step: "wingf", p1: "-0.7811948794,0.1000097047", p2: "-1,0.1000026109", move: "-0.890598,0.130006", sign: 1 },
    { step: "wingf", p1: "-0.7811954143,0.1000070171", p2: "-0.5953191667,0.023014044", move: "-0.676773,0.089226", sign: -1 },
    { step: "wingb", p1: "0.0999788624,-0.781201018", p2: "0.0230079208,-0.5953166304", move: "0.089211,-0.676779", sign: 1, deg: -90, at: 21.8, dur: 0.8, to: 1 },
    { step: "wingb", p1: "0.0999646969,-0.7812038374", p2: "0.1000137004,-1", move: "0.129991,-0.890598", sign: -1 },
    { step: "wingb", p1: "0.2088845058,-0.5182988813", p2: "0.3635786374,-0.3635786374", move: "0.307446,-0.462151", sign: 1 },
    { step: "wingb", p1: "0.2088845058,-0.5182988813", p2: "0.0230069267,-0.5953162187", move: "0.127433,-0.58452", sign: -1 },
    { step: "wingb", p1: "0.5953090293,-0.0229895701", p2: "0.5183552825,-0.2089222076", move: "0.584553,-0.12743", sign: -1 },
    { step: "wingb", p1: "0.3635649696,-0.3635649696", p2: "0.5183524683,-0.2089203265", move: "0.462165,-0.307465", sign: 1 },
    { step: "wingb", p1: "1,-0.1000033065", p2: "0.7811892358,-0.1000380598", move: "0.890599,-0.130022", sign: -1 },
    { step: "wingb", p1: "0.5953090293,-0.0229895701", p2: "0.7811893536,-0.1000374682", move: "0.676764,-0.089231", sign: 1 },
    // ── the collapse, keyframed along the squash's solved path ──
    // squash 1 + press right (the peels are the same physical creases as
    // s1/s2, so they carry the same keyframes until their petal opens them)
    ...kf(["s1", "peelfr", "peelbr"], [
      [4.5, 0.5, -0.39], [5, 0.5, -0.659], [5.5, 0.5, -0.9645],
      [6.5, 0.5, -0.9945], [7, 0.5, -0.997], [7.5, 0.5, -0.998],
      [8, 0.5, -0.9985], [8.5, 0.5, -1],
    ]),
    ...kf(["hv"], [
      [4.5, 0.5, 0.498], [5, 0.5, 0.744], [5.5, 0.5, 0.95],
      [6.5, 0.5, 0.83], [7, 0.5, 0.712], [7.5, 0.5, 0.474],
      [8, 0.5, 0.238], [8.5, 0.5, 0],
      [9.5, 0.25, 0.176], [9.75, 0.5, 0.484], [10.25, 0.25, 0.61],
      [10.5, 0.75, 0.914], [11.25, 0.25, 0.958],
      [12.5, 0.5, 0.718], [13, 0.5, 0.48], [13.5, 0.5, 0.24], [14, 0.5, 0],
    ]),
    ...kf(["spine", "spineN", "spineH"], [
      [4, 2, 0], [6.5, 0.5, -0.163], [7, 0.5, -0.284],
      [7.5, 0.5, -0.526], [8, 0.5, -0.763], [8.5, 0.5, -1],
    ]),
    // squash 2 + press left
    ...kf(["s2", "peelfl", "peelbl"], [
      [9.75, 0.5, -0.375], [10.25, 0.25, -0.5], [10.5, 0.75, -0.875], [11.25, 0.25, -1],
    ]),
    ...kf(["still", "stillN"], [
      [9.5, 0.25, 0.825], [9.75, 0.5, 0.518], [10.25, 0.25, 0.392],
      [10.5, 0.75, 0.089], [11.25, 0.25, -0.044],
      [12.5, 0.5, -0.283], [13, 0.5, -0.523], [13.5, 0.5, -0.762], [14, 0.5, -1],
    ]),
    // the peels: each petal's lift unfolds its own side's ridges — most of
    // the way through the lift, the rest in the wing snap
    ...kf(["peelfr", "peelfl"], [[14.6, 0.3333, -0.62], [14.9333, 0.0333, 0]]),
    ...kf(["peelbr", "peelbl"], [[15.3667, 0.3333, -0.62], [15.7, 0.0333, 0]]),
    // the reverse folds, each in two moves on the strain-solved path: the
    // POP — the point swings through its own layers about the leg's axis
    // (all its lengthwise folds lie on one world line, a nearly free
    // hinge: spineN flips −1→1 while the kite/thin halves flip 1→−1) —
    // then the PRESS, the reverse crease folding flat while the wraps
    // breathe open and shut
    ...kf(["spineN", "spineH"], [[18.6, 0.12, 1]]),
    ...kf(["kite2N", "kite4N", "thinfrN", "thinbrN", "kite2H", "kite4H", "thinfrH", "thinbrH"],
      [[18.72, 0.15, -1], [19.12, 0.07, -0.35], [19.19, 0.31, -1]]),
    ...kf(["stillN"], [[19.7, 0.12, 1]]),
    ...kf(["kiteN", "kite3N", "thinflN", "thinblN"],
      [[19.82, 0.15, -1], [19.97, 0.25, -0.72], [20.22, 0.18, -0.88], [20.4, 0.2, -1]]),
    // the head's reverse: pop the tip through (spineH flips back, then its
    // wraps), then the head crease presses flat
    ...kf(["spineH"], [[20.8, 0.12, -1]]),
    ...kf(["kite2H", "kite4H", "thinfrH", "thinbrH"], [[20.92, 0.15, 1]]),
  ])
})

// Feed the creases to a sheet of paper. One steady head-on view for the
// whole sequence — the paper faces the camera flat, like the diagrams,
// rotated so the finished base sits POINT DOWN as a diamond. (Add "update"
// rows with rx/ry/rz to re-pose the paper mid-sequence.)
define("events", (rand, table) => {
  const paper = origami().steps(table("steps"))
  return paper.spawn({ id: "base", color: 0xd94f2a, py: 0, pz: 1.2, rx: 0, ry: 0, rz: 2.356 })
    .concat(paper.sequence())
})

// Bake to a 23-beat loop cache — when the loop wraps, the paper opens flat
// and folds itself all over again.
define("scene", (rand, table) => table("events").rasterize(23))

// A whisper of video feedback (the rendered scene is hydra's s0) so the
// paper leaves faint trails as it moves. Delete this view for a clean look.
define("hydra", () => rows([
  { beat: 1, event: "setCode",
    code: "src(s0).blend(src(o0).scale(1.003), 0.18).out(o0)" },
]))

// Things to try, live in the "steps" tab:
//   - Delete the s1/hv keyframes after the first of each: the squash stops
//     a quarter of the way in and holds — scrub to study the mechanism.
//   - Drive "hv" to 0.95 again at beat 17 and the bird base opens its beak.
//   - Slide a crease: nudge the petal's p1/p2 endpoints and the wings no
//     longer land on the centre line — the paper visibly strains around
//     the misplaced mechanism, because every other crease is exactly where
//     the real fold needs it.
`,
  },
  {
    name: "Origami Jumping Frog",
    code: `// livecodata — Origami Jumping Frog (the classic schoolyard frog)
// A square folds itself from a STATIC TABLE OF CREASES — same dialect as
// the Origami Crane sample (see its header for the full column notes):
// every row is one crease given outright; rows sharing a "step" are one
// fold through several layers; "sign" is the layer's turning sense
// (mirrored plies turn the other way); at/dur/to schedule the drive.
//
// The sequence (all flat folds, straight off the classic diagrams):
//   halve     fold the square in half, left onto right (beat 1)
//   the head  waterbomb-collapse the TOP SQUARE of the halved model:
//             both diagonals valley, the horizontal midline mountain —
//             the top square becomes the head triangle, base on the
//             body, apex up (beats 3–5). Each crease is written twice,
//             once per sheet layer, mirrored with the opposite sign.
//   legL/legR the front legs: fold each loose corner of the triangle up
//             to the apex. Each flap is the L_t/T ply pair — the two
//             plies whose spine lies INSIDE the flap (the other pair is
//             continuous with the body and stays), times two layers.
//   sideL/R   fold the body's sides onto the centre line. The creases
//             run past the triangle's base to the diagonal creases, so
//             the hidden corner slivers under the head ride along.
//   bottomup  fold the bottom edge up to the triangle's base,
//   pleat     then fold the same flap in half back down — the zigzag
//             spring the frog jumps with.
// Every crease was sliced ply-by-ply off the folded model; every fold's
// end pose closes exactly (zero strain); mid-fold the paper lerps and
// flexes like real paper rather than following a solved rigid path.

define("steps", () => editable("steps", {
  step: "string", p1: "string", p2: "string", move: "string",
  sign: "number", deg: "number", at: "number", dur: "number", to: "number",
}, [
  // fold in half: left onto right
  { step: "halve", p1: "bottom@0.5", p2: "top@0.5", move: "-0.5,0", sign: 1, deg: 180, at: 1, dur: 1.5, to: -1 },
  // the waterbomb collapse of the top square (world x 0..1, y 0..1):
  // horizontal midline (mountain), then the two diagonals (valleys) —
  // rows ordered so each row's move sample lands in its own piece
  { step: "horiz", p1: "0,0.5", p2: "1,0.5", move: "0.5,0.75", sign: -1, deg: 180, at: 3, dur: 2, to: -1 },
  { step: "horiz", p1: "-1,0.5", p2: "0,0.5", move: "-0.5,0.75", sign: -1 },
  { step: "diagB", p1: "1,0", p2: "0,1", move: "0.85,0.3", sign: 1, deg: 180, at: 3, dur: 2, to: 1 },
  { step: "diagB", p1: "-1,0", p2: "0,1", move: "-0.85,0.3", sign: -1 },
  { step: "diagA", p1: "0,0", p2: "1,1", move: "0.15,0.4;0.5,0.85", sign: -1, deg: 180, at: 3, dur: 2, to: 1 },
  { step: "diagA", p1: "0,0", p2: "-1,1", move: "-0.15,0.4;-0.5,0.85", sign: -1 },
  // front legs: each loose corner up to the apex, four plies per flap
  { step: "legL", p1: "-0.5,1", p2: "-0.25,0.75", move: "-0.353789,0.89622", sign: -1, deg: 180, at: 5.6, dur: 1, to: 1 },
  { step: "legL", p1: "0,0.5", p2: "-0.25,0.75", move: "-0.103783,0.646208", sign: -1 },
  { step: "legL", p1: "0,0.5", p2: "0.25,0.75", move: "0.103782,0.64621", sign: 1 },
  { step: "legL", p1: "0.5,1", p2: "0.25,0.75", move: "0.353794,0.896213", sign: 1 },
  { step: "legR", p1: "-1,0.5", p2: "-0.75,0.75", move: "-0.89622,0.646209", sign: 1, deg: 180, at: 6.9, dur: 1, to: 1 },
  { step: "legR", p1: "-0.5,1", p2: "-0.75,0.75", move: "-0.646212,0.896217", sign: 1 },
  { step: "legR", p1: "0.5,1", p2: "0.75,0.75", move: "0.646227,0.896209", sign: 1 },
  { step: "legR", p1: "1,0.5", p2: "0.75,0.75", move: "0.896212,0.646218", sign: 1 },
  // sides onto the centre line (the creases run to the diagonals, so the
  // corner slivers under the head fold along with the body)
  { step: "sideL", p1: "-0.25,-1", p2: "-0.25,0.25", move: "-0.22,-0.375001", sign: -1, deg: 180, at: 8.2, dur: 0.8, to: -1 },
  { step: "sideL", p1: "0,0.25", p2: "-0.25,0.25", move: "-0.125,0.220001", sign: -1 },
  { step: "sideL", p1: "0,0.25", p2: "0.25,0.25", move: "0.125,0.220001", sign: -1 },
  { step: "sideL", p1: "0.25,-1", p2: "0.25,0.25", move: "0.22,-0.375", sign: -1 },
  { step: "sideR", p1: "-1,0.25", p2: "-0.75,0.25", move: "-0.874995,0.22001", sign: -1, deg: 180, at: 9.2, dur: 0.8, to: -1 },
  { step: "sideR", p1: "-0.75,-1", p2: "-0.75,0.25", move: "-0.779989,-0.375018", sign: -1 },
  { step: "sideR", p1: "0.75,-1", p2: "0.75,0.25", move: "0.78,-0.375", sign: -1 },
  { step: "sideR", p1: "1,0.25", p2: "0.75,0.25", move: "0.875,0.220001", sign: -1 },
  // the spring: bottom edge up to the triangle's base...
  { step: "bottomup", p1: "-1,-0.5", p2: "-0.75,-0.5", move: "-0.875,-0.53002", sign: 1, deg: 180, at: 10.4, dur: 1, to: 1 },
  { step: "bottomup", p1: "-0.25,-0.5", p2: "-0.75,-0.5", move: "-0.5,-0.530036", sign: 1 },
  { step: "bottomup", p1: "-0.25,-0.5", p2: "0,-0.5", move: "-0.125,-0.530028", sign: 1 },
  { step: "bottomup", p1: "0.25,-0.5", p2: "0,-0.5", move: "0.125,-0.530022", sign: 1 },
  { step: "bottomup", p1: "0.25,-0.5", p2: "0.75,-0.5", move: "0.5,-0.530008", sign: 1 },
  { step: "bottomup", p1: "1,-0.5", p2: "0.75,-0.5", move: "0.875,-0.53", sign: 1 },
  // ...and the flap folded in half back down
  { step: "pleat", p1: "-1,-0.75", p2: "-0.75,-0.75", move: "-0.874999,-0.779984", sign: 1, deg: 180, at: 11.7, dur: 1, to: -1 },
  { step: "pleat", p1: "-0.25,-0.75", p2: "-0.75,-0.75", move: "-0.500001,-0.779987", sign: 1 },
  { step: "pleat", p1: "-0.25,-0.75", p2: "0,-0.75", move: "-0.124999,-0.779991", sign: 1 },
  { step: "pleat", p1: "0.25,-0.75", p2: "0,-0.75", move: "0.125,-0.779988", sign: 1 },
  { step: "pleat", p1: "0.25,-0.75", p2: "0.75,-0.75", move: "0.500001,-0.779996", sign: 1 },
  { step: "pleat", p1: "1,-0.75", p2: "0.75,-0.75", move: "0.874999,-0.780006", sign: 1 },
]))

// Feed the creases to a green sheet, head-on like the diagrams.
define("events", (rand, table) => {
  const paper = origami().steps(table("steps"))
  return paper.spawn({ id: "frog", color: 0x3d9b4f, py: 0, pz: 1.2, rx: 0, ry: 0, rz: 0 })
    .concat(paper.sequence())
})

// Bake to a 13.5-beat loop — fold, hold a moment, open flat, fold again.
define("scene", (rand, table) => table("events").rasterize(13.5))

// Things to try, live in the "steps" tab:
//   - Flip the "pleat" row's \`to\` to −1: the spring folds the other way
//     and the frog sits up on its haunches.
//   - Drive "legL"/"legR" to 0 again at beat 12.5: the frog throws its
//     front legs forward as if mid-jump.
`,
  },
  {
    name: "Hydra Sketch",
    code: `// livecodata — a video-synth sketch with hydra (hydra-ts, a port of ojack's hydra)
// A generative hydra sketch — no 3D scene involved (see "House of Cards" for
// hydra post-processing a rendered scene via src(s0)). Press "Run" (or
// Cmd/Ctrl-Enter), then hit Play.

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
// editable(name, schema, seedRows?) makes this table live-editable in the
// table panel — it's the ONLY table this sketch needs (named "hydra" so
// playback reads it directly, with no code-generated view in between): click
// the code cell to open the sketch in this editor; edit a value cell, or "+
// row" a new setVariable event at a later beat (like the row below, at beat
// 9) right in the table — no code change needed, and any column you add via
// "+ column" survives the next Run too. (Every edit is an event too — see the
// "hydra·events" tab.) A second, code-generated table only becomes useful
// once you need to LAYER computed events on top of these — see "House of
// Cards" for that.
editable("hydra", { beat: "number", event: "string", code: "code", name: "string", value: "number" }, [
  { beat: 1, event: "setCode",
    code: "osc((props) => props.freq, 0.1, 1.5).kaleid(5).out(o0)" },
  { beat: 1, event: "setVariable", name: "freq", value: 3 },
  { beat: 9, event: "setVariable", name: "freq", value: 12 },
])
`,
  },
  {
    name: "House of Cards",
    code: `// livecodata — House of Cards
// A triangular pyramid of playing cards collapses when a ball drops on it.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.
// Tips: Ctrl-Space completes views, Table verbs, and Expr methods (the methods
// after field()/lit()/idx() — e.g. field("v").add(1).gt(2)); hover a "view" name
// to preview its table; your caret selects that view's tab on the right.

// 1. Build a 3-story pyramid of cards plus a falling ball.
//    Story k has (n − k) leaning-card tent pairs and (n − k − 1) horizontal
//    bridge cards between them. Card positions are derived analytically from the
//    lean angle so each card's lowest rotated corner rests on its support surface.
define("base", () => {
  const lean = 0.25                    // radians from vertical (~14°)
  const H = 0.35, W = 0.22, T = 0.04  // card half-height, half-width, half-thickness
  const sl = Math.sin(lean), cl = Math.cos(lean)
  const dx    = H * sl                 // card-center x offset from tent apex
  const cyOff = W * sl + H * cl       // support-surface to card-center (no corner overlap)
  const S     = 0.50                   // spacing between adjacent tent apices
  const n     = 3                      // tents on the ground floor (try 4 for ~27 cards)

  const cards = []
  let supportY = -1.0                  // current support surface y (floor to start)

  for (let k = 0; k < n; k++) {
    const numTents = n - k
    const cardCY   = supportY + cyOff
    const topY     = supportY + W * sl + 2 * H * cl  // tent apex y
    const bHx      = S / 2 + 0.03                    // bridge half-span

    // Leaning card pairs — two cards per tent, tops meeting at the apex
    for (let i = 0; i < numTents; i++) {
      const tx = -(numTents - 1) * S / 2 + i * S     // apex x
      cards.push(
        { id: "s" + k + "t" + i + "a", type: "create", shape: "box", color: 0xfdf6e3,
          motion: "dynamic", friction: 0.8, restitution: 0,
          px: tx - dx, py: cardCY, pz: 0, hx: T, hy: H, hz: W, rz: -lean },
        { id: "s" + k + "t" + i + "b", type: "create", shape: "box", color: 0xfdf6e3,
          motion: "dynamic", friction: 0.8, restitution: 0,
          px: tx + dx, py: cardCY, pz: 0, hx: T, hy: H, hz: W, rz:  lean },
      )
    }

    // Horizontal bridge cards spanning adjacent tent apices
    for (let i = 0; i < numTents - 1; i++) {
      const bx = -(numTents - 1) * S / 2 + (i + 0.5) * S
      cards.push(
        { id: "s" + k + "b" + i, type: "create", shape: "box", color: 0xe74c3c,
          motion: "dynamic", friction: 0.8, restitution: 0,
          px: bx, py: topY + T, pz: 0, hx: bHx, hy: T, hz: W },
      )
    }

    // Crown on the top-story apex (replaces bridges on the final story)
    if (k === n - 1) {
      cards.push(
        { id: "crown", type: "create", shape: "box", color: 0xe74c3c,
          motion: "dynamic", friction: 0.8, restitution: 0,
          px: 0, py: topY + T, pz: 0, hx: bHx, hy: T, hz: W },
      )
    }

    supportY = topY + 2 * T  // bridge top surface becomes next story's floor
  }

  return rows([
    { id: "floor", type: "create", shape: "box", color: 0x1a2e1a,
      motion: "static", px: 0, py: -1.2, pz: 0, hx: 4, hy: 0.2, hz: 4 },
    { id: "ball",  type: "create", shape: "sphere", color: 0xf39c12,
      motion: "dynamic", restitution: 0.2, r: 0.12,
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
  table("events").filter(r => r.type === "collision")
)

define("ball_height", (rand, table) =>
  table("events")
    .filter(r => r.id === "ball" && r.type === "update")
    .map(r => ({ beat: r.beat, height: r.py }))
    .graph("height")
)

// 5. Post-processing is a hydra sketch (hydra-ts). A hydra table is a stream
//    of setCode/setVariable EVENTS (see "Hydra Sketch" for the plain case):
//    s0 is the rendered 3D scene; o0 is the output, so src(s0)...out()
//    post-processes the scene. The most-recent setCode wins, and each
//    variable holds its most-recent setVariable value until a later one
//    changes it — referenced as (props) => props.amount rather than the bare
//    name, so every collision's new value takes effect immediately, without
//    recompiling the sketch (a recompile would restart its oscillator phase,
//    visible as a stutter on every landing).
//    Every row sits on a \`beat\` — the base sketch at beat 1, and each
//    collision-driven \`amount\` bump at the beat its landing baked to (physics
//    and hydra share the one beat grid, so the bumps line up with the crash).
//    This is the two-TABLE case: the base sketch lives in the EDITABLE
//    "hydra sketch" table (seeded below, its own tab — click its code cell to
//    open the sketch in this editor, tweak, Ctrl-Enter to apply, and the edit
//    lands in the table's event log at "hydra sketch·events") while "hydra"
//    is a code-GENERATED view layering the collision-driven \`amount\` events
//    on top — data-driven from "sim" (filter the sibling, not "events", or
//    we'd cycle). Reach for two tables like this only when you need computed
//    events layered on the user-authored ones; otherwise a single editable
//    table named "hydra" (see "Hydra Sketch") is all you need.
define("hydra", (rand, table) =>
  editable("hydra sketch", { beat: "number", event: "string", code: "code", name: "string", value: "number" }, [
    { beat: 1, event: "setCode",
      code: "src(s0).modulate(osc(2.5, 0.1), (props) => props.amount).out(o0)" },
    { beat: 1, event: "setVariable", name: "amount", value: 0.12 },
  ]).concat(
    // Declarative, diffable form: filter(Expr) + emit(template). Values are Expr
    // nodes (field("beat").add(0.5)) so the engine can hash this view and reuse
    // it — editing here never re-bakes the physics in "sim". Each landing kicks
    // \`amount\` up, then half a beat later a row settles it back down.
    table("sim")
      .filter(field("type").eq("collision").and(field("other").eq("floor")))
      .emit([
        { beat: field("beat"), event: "setVariable", name: "amount", value: 0.6 },
        { beat: field("beat").add(0.5), event: "setVariable", name: "amount", value: 0.12 },
      ])
  )
)

// 6. Beat-synced looping (optional). Tap the Tap button under the scene a few
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
