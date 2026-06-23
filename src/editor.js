import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'

const initialDoc = `// livecodata — define tables as views; the engine cooks them each run.
// Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. A noisy sine wave: one row per frame, 360 frames (~6s at 60fps).
//    rand is a seeded per-view PRNG, so replaying a session reproduces it exactly.
//    Each row is { index, value }; .graph plots value against the index.
define("randsin", (rand) =>
  math(i => Math.sin(i * Math.PI / 15) + (rand() * 0.5 - 0.25))
    .range(360)
    .graph("value")
)

// 2. The base scene: object-creation events. The "events" 3rd arg tags this view
//    into a group — the engine merges every member into an index-sorted "events"
//    table for free, so there's no manual concat/sort below.
define("base", "events", () =>
  rows([
    { id: "sphere1", type: "create", index: 0, shape: "sphere", color: 0x4a9eff,
      px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
  ])
)

// 3. Flash every object white when the wave crosses zero, then back to its own
//    color. Instead of hard-coding ids, derive the objects from "base":
//    filterMap keeps the create events and maps each to a flash/restore pair per
//    crossing. Also tagged into "events", so it merges with the creates above.
define("flash_white", "events", (rand, table) => {
  const crossings = table("randsin").filterMap((cur, i, rows) =>
    i > 0 && cur.value * rows[i - 1].value < 0 ? { index: cur.index } : null
  )
  return table("base").filterMap(o =>
    o.type !== "create" ? null : crossings.rows.flatMap(c => [
      { id: o.id, type: "color", index: c.index,     color: 0xffffff },
      { id: o.id, type: "color", index: c.index + 4, color: o.color },
    ])
  )
})
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
