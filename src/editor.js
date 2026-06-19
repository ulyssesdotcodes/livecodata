import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap } from '@codemirror/view'

const initialDoc = `// livecodata — generate tables, drive visuals.
// Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. A noisy sine wave: one row per frame at 60fps over 6 seconds.
//    Each row is { frame, time, value }.
math(t => Math.sin(t * Math.PI * 4) + (Math.random() * 0.5 - 0.25))
  .range(6)
  .save("randsin")

// 2. A base scene: a single sphere sitting at the origin.
rows([
  { id: "sphere1", type: "create", time: 0, shape: "sphere", color: 0x4a9eff,
    px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
]).save("base")

// 3. Whenever the wave crosses zero, flash the sphere white, then back.
//    fold walks the rows like Array.reduce; the previous row is all[i - 1],
//    and we push event rows onto the accumulator when the sign flips.
rows(
  table("randsin").fold((out, cur, i, all) => {
    if (i > 0 && cur.value * all[i - 1].value < 0) {
      out.push(
        { id: "sphere1", type: "color", time: cur.time,        color: 0xffffff },
        { id: "sphere1", type: "color", time: cur.time + 0.06, color: 0x4a9eff },
      )
    }
    return out
  }, []),
)
  .concat(table("base"))
  .sortBy("time")
  .save("events")
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
      keymap.of([
        { key: 'Mod-Enter', run: () => { run(); return true } },
      ]),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ],
    parent: host,
  })

  runBtn.onclick = run

  return { run, getCode: () => view.state.doc.toString() }
}
