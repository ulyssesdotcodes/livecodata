import { EditorView, basicSetup } from 'codemirror'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap, hoverTooltip } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { buildTablePreview } from './preview.js'

// Completed by the editor. Builtins are the DSL surface (createDSL in dsl.js);
// methods are Table/builder methods offered after a dot. Kept in sync by hand.
const DSL_BUILTINS = ['define', 'table', 'math', 'rows', 'csv', 'json', 'grid',
  'linear', 'easeIn', 'easeOut', 'easeInOut']
const TABLE_METHODS = ['map', 'filter', 'filterMap', 'concat', 'slice', 'fold', 'scan',
  'join', 'zip', 'orderBy', 'derive', 'assign', 'mapField', 'rescale', 'lag',
  'groupBy', 'agg', 'count', 'trigger', 'triggerEach', 'crossings',
  'range', 'rasterize', 'graph', 'save']

// Which view's define(...) block the caret sits in: the latest define("X" whose
// header starts at or before pos (define()s are top-level and sequential).
function viewAtPos(text, pos) {
  const re = /\bdefine\(\s*"([^"]+)"/g
  let m
  let name = null
  while ((m = re.exec(text))) {
    if (m.index <= pos) name = m[1]
    else break
  }
  return name
}

// A completion source for the DSL: defined view names inside table("…")/define("…"),
// Table methods after a dot, and builtins otherwise. `getViews` returns the live
// Map of cooked views, so view-name completion reflects the last run.
function dslCompletions(getViews) {
  return (context) => {
    // Inside a table("…") / define("…") string → complete defined view names.
    if (context.matchBefore(/\b(?:table|define)\(\s*"[^"]*/)) {
      const open = context.matchBefore(/"[^"]*/)
      const names = [...(getViews?.() ?? new Map()).keys()]
      if (!names.length) return null
      return {
        from: open ? open.from + 1 : context.pos,
        options: names.map((n) => ({ label: n, type: 'variable' })),
        validFor: /^[^"]*$/,
      }
    }
    // After a dot → Table / builder methods.
    const dot = context.matchBefore(/\.\w*/)
    if (dot) {
      return { from: dot.from + 1, options: TABLE_METHODS.map((label) => ({ label, type: 'method' })), validFor: /^\w*$/ }
    }
    // Otherwise → DSL builtins (only while typing a word, or on explicit request).
    const word = context.matchBefore(/\w+/)
    if (!word && !context.explicit) return null
    return { from: word ? word.from : context.pos, options: DSL_BUILTINS.map((label) => ({ label, type: 'function' })), validFor: /^\w*$/ }
  }
}

const initialDoc = `// livecodata — define tables as views; the engine cooks them each run.
// Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play under the scene.
// Tips: Ctrl-Space completes views & Table verbs; hover a "view" name to preview
// its table; your caret selects that view's tab on the right.

// A grid of spheres. Bump GRID to stress-test playback (GRID*GRID objects,
// each baked into every frame of the dense cache).
const GRID = 10

// 1. A noisy sine wave: one row per frame, 360 frames (~6s at 60fps).
//    rand is a seeded per-view PRNG, so replaying a session reproduces it exactly.
//    Each row is { index, value }; .graph plots value against the index.
define("randsin", (rand) =>
  math(i => Math.sin(i * Math.PI / 15) + (rand() * 0.5 - 0.25))
    .range(360)
    .graph("value")
)

// 2. The base scene: grid() lays out a GRID x GRID lattice (rows carry px/pz/col/
//    row); derive() turns each cell into a "create" event. The "events" 3rd arg
//    tags it into a group the engine merges (index-sorted) for free. "ripple"
//    gives each sphere a diagonal delay used by the flash below.
define("base", "events", () =>
  grid(GRID, GRID).derive({
    id: r => "s" + r.i, type: "create", index: 0, shape: "sphere", color: 0x4a9eff,
    rx: 0, ry: 0, rz: 0, ripple: r => (r.col + r.row) * 2,
  })
)

// 3. Each zero-crossing of the wave flashes every sphere. triggerEach fires when
//    the predicate is true (the wave crosses zero) and fans the event out across
//    base's objects — one pulse each, with the sphere's "ripple" delay. A pulse
//    flashes then eases back over "dur" frames (newest wins). Lineage threads
//    through the fan-out, so each flash traces back to the sample that fired it
//    AND its sphere — watch the graph/table light up during playback.
//    (Sugar: table("randsin").crossings("value") gives the crossings directly.)
define("flash", "events", (rand, table) =>
  table("randsin").triggerEach(
    (cur, i, rows) => i > 0 && cur.value * rows[i - 1].value < 0,
    table("base"),
    (o, cur) => ({
      id: o.id, type: "color", index: cur.index + o.ripple,
      color: 0xff5577, dur: 36, ease: easeOut,
    })
  )
)

// 4. The frame cache: bake the sparse "events" into dense per-frame world state
//    (one row per object per frame). Playback indexes straight into this.
define("scene", () => table("events").rasterize(360))

// 5. (Optional) The timeline is data too: map each playback tick to a source
//    cache frame. Uncomment to loop the first 60 frames, or reverse time.
// define("timeline", () => math(i => i % 60).range(360).map(r => ({ frame: r.value })))
// define("timeline", () => math(i => 359 - i).range(360).map(r => ({ frame: r.value })))
`

// A hover tooltip: hovering a "name" string that matches a cooked view pops an
// inline preview (sparkline + first rows) of that table. `getViews` supplies the
// live views from the last cook.
function dslHover(getViews) {
  return hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos)
    const re = /"([^"]+)"/g
    let m
    while ((m = re.exec(line.text))) {
      const start = line.from + m.index
      const end = start + m[0].length
      if (pos < start || pos > end) continue
      const table = (getViews?.() ?? new Map()).get(m[1])
      if (!table) return null
      return { pos: start, end, above: true, create: () => ({ dom: buildTablePreview(table) }) }
    }
    return null
  })
}

export function initEditor(parent, { onRun, getViews, onCaretView } = {}) {
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

  // The view whose define() block the caret last sat in — debounces panel sync.
  let lastCaretView = null

  const view = new EditorView({
    doc: initialDoc,
    extensions: [
      basicSetup,
      javascript(),
      // DSL autocomplete (view names / Table methods / builtins). Added as a JS
      // language-data source so basicSetup's autocompletion picks it up.
      javascriptLanguage.data.of({ autocomplete: dslCompletions(getViews) }),
      // Caret → panel link: select the table for the define() block being edited.
      EditorView.updateListener.of((u) => {
        if (!onCaretView || !(u.selectionSet || u.docChanged)) return
        const name = viewAtPos(u.state.doc.toString(), u.state.selection.main.head)
        if (name && name !== lastCaretView) {
          lastCaretView = name
          onCaretView(name)
        }
      }),
      // Hover a "view" string to preview its table (sparkline + first rows).
      dslHover(getViews),
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
