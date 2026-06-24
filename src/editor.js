import { EditorView, basicSetup } from 'codemirror'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap, hoverTooltip } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { vim } from '@replit/codemirror-vim'
import { buildTablePreview } from './preview.js'

// Completed by the editor. Builtins are the DSL surface (createDSL in dsl.js);
// methods are Table/builder methods offered after a dot. Kept in sync by hand.
const DSL_BUILTINS = ['define', 'table', 'math', 'rows', 'csv', 'json', 'grid',
  'physics', 'linear', 'easeIn', 'easeOut', 'easeInOut']
const TABLE_METHODS = ['map', 'filter', 'filterMap', 'concat', 'slice', 'fold', 'scan',
  'join', 'zip', 'orderBy', 'derive', 'assign', 'mapField', 'rescale', 'lag',
  'groupBy', 'agg', 'count', 'trigger', 'triggerEach', 'crossings',
  'range', 'rasterize', 'simulate', 'graph', 'save']

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

// 1. The base scene: a static floor and three shapes to drop on it. Each create
//    row carries physics fields — motion, spawn position (px/py/pz) and rotation
//    (rx/ry/rz). The floor's physics half-extents (hx/hy/hz) are wider than the
//    drawn mesh, so things land instead of rolling off.
define("base", () =>
  rows([
    { id: "floor", type: "create", shape: "box", color: 0x222244,
      motion: "static", px: 0, py: -1.2, pz: 0, hx: 3, hy: 0.2, hz: 3 },
    { id: "ball",  type: "create", shape: "sphere",   color: 0x4a9eff,
      motion: "dynamic", px: -0.5, py: 3.0, pz: 0.0 },
    { id: "box1",  type: "create", shape: "box",      color: 0xff6b6b,
      motion: "dynamic", px: 0.4,  py: 4.5, pz: 0.2, rx: 0.4, ry: 0.3 },
    { id: "cyl",   type: "create", shape: "cylinder", color: 0x51cf66,
      motion: "dynamic", px: 0.0,  py: 6.0, pz: -0.3 },
  ])
)

// 2. Bake a JoltPhysics simulation in the background: step the world for 240
//    frames (~4s at 60fps). simulate() ADDS to the table — a per-frame "update"
//    row for each moving body (the baked motion the cache interpolates between)
//    plus a "collision" row whenever two bodies first touch.
define("events", (rand, table) =>
  physics(table("base")).simulate({ steps: 240, gravity: -9.81 })
)

// 3. The frame cache: bake the sparse "events" into dense per-frame world state
//    that playback indexes straight into.
define("scene", (rand, table) => table("events").rasterize(240))

// 4. Collisions are just rows — pull them into their own view to inspect, and
//    graph the ball's height over time as it bounces and settles.
define("collisions", (rand, table) =>
  table("events").filter(r => r.type === "collision")
)

define("ball_height", (rand, table) =>
  table("events")
    .filter(r => r.id === "ball" && r.type === "update")
    .map(r => ({ index: r.index, height: r.py }))
    .graph("height")
)
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
      vim(),
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
