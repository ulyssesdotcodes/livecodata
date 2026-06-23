import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'

const initialDoc = `// livecodata — define tables as views; the engine cooks them each run.
// Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// A grid of spheres. Bump GRID to stress-test playback (GRID*GRID objects,
// each baked into every frame of the dense cache).
const GRID = 10
const COUNT = GRID * GRID

// 1. A noisy sine wave: one row per frame, 360 frames (~6s at 60fps).
//    rand is a seeded per-view PRNG, so replaying a session reproduces it exactly.
//    Each row is { index, value }; .graph plots value against the index.
define("randsin", (rand) =>
  math(i => Math.sin(i * Math.PI / 15) + (rand() * 0.5 - 0.25))
    .range(360)
    .graph("value")
)

// 2. The base scene: a GRID x GRID lattice of spheres centred on the origin.
define("base", () =>
  rows(Array.from({ length: COUNT }, (_, k) => ({
    id: "s" + k, type: "create", index: 0, shape: "sphere", color: 0x4a9eff,
    px: ((k % GRID) - (GRID - 1) / 2) * 0.7, py: 0,
    pz: (Math.floor(k / GRID) - (GRID - 1) / 2) * 0.7,
    rx: 0, ry: 0, rz: 0,
  })))
)

// 3. Each zero-crossing of the wave fires a flash that ripples across the grid.
//    A pulse is ONE self-contained event: it flashes to `color`, then `ease`s
//    back to the sphere's base over `dur` frames. Overlapping pulses don't fight
//    — at any frame the newest pulse wins — so this stays correct no matter how
//    densely the crossings land. table("randsin") records the dependency.
define("events", (rand, table) =>
  table("randsin")
    .scan((state, cur) => {
      const crossed = state.prev != null && cur.value * state.prev < 0
      return {
        state: { prev: cur.value },
        emit: crossed
          ? Array.from({ length: COUNT }, (_, k) => ({
              id: "s" + k, type: "color",
              index: cur.index + (k % GRID + Math.floor(k / GRID)) * 2, // diagonal ripple
              color: 0xff5577, dur: 36, ease: easeOut,
            }))
          : null,
      }
    }, { prev: null })
    .concat(table("base"))
    .sortBy("index")
)

// 4. The frame cache: bake the sparse events into dense per-frame world state
//    (one row per object per frame), with color eased per the pulses above.
//    Playback indexes straight into this.
define("scene", (rand, table) => table("events").rasterize(360))

// 5. (Optional) The timeline is data too: map each playback tick to a source
//    cache frame. Uncomment to loop the first 60 frames, or reverse time — the
//    table/graph cursor follows the *source* frame either way.
// define("timeline", () => math(i => i % 60).range(360).map(r => ({ frame: r.value })))
// define("timeline", () => math(i => 359 - i).range(360).map(r => ({ frame: r.value })))
`

export function initEditor(parent, { onRun } = {}) {
  parent.innerHTML = ''

  const header = document.createElement('div')
  header.className = 'editor-header'

  const titleEl = document.createElement('span')
  titleEl.className = 'editor-title'
  titleEl.textContent = 'DSL'
  header.appendChild(titleEl)

  const runBtn = document.createElement('button')
  runBtn.className = 'run-btn'
  runBtn.textContent = 'Run ▶'
  header.appendChild(runBtn)

  parent.appendChild(header)

  const host = document.createElement('div')
  host.className = 'editor-host'
  parent.appendChild(host)

  const errEl = document.createElement('div')
  errEl.className = 'editor-error'
  errEl.style.display = 'none'
  parent.appendChild(errEl)

  function setError(msg) {
    if (msg) {
      errEl.textContent = msg
      errEl.style.display = 'block'
    } else {
      errEl.textContent = ''
      errEl.style.display = 'none'
    }
  }

  function run() {
    onRun?.(view.state.doc.toString(), { setError })
  }

  const view = new EditorView({
    doc: initialDoc,
    extensions: [
      basicSetup,
      javascript(),
      oneDark,
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', run: () => { run(); return true } },
      ])),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ],
    parent: host,
  })

  runBtn.onclick = run

  // Replace the whole document (used to restore a rehydrated session's program).
  function setCode(code) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } })
  }

  return { run, getCode: () => view.state.doc.toString(), setCode, setError }
}
