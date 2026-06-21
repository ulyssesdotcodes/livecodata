import './style.css'
import { initThree } from './three-scene.js'
import { initEditor } from './editor.js'
import { initTablePanel } from './table-panel.js'
import { initGraphPanel } from './graph-panel.js'
import { initPlayback } from './playback.js'
import { createDSL } from './dsl.js'
import { createLog, randomSeed } from './log.js'

const sceneAPI = initThree(document.getElementById('three-canvas'))
const tablePanel = initTablePanel(document.getElementById('table-pane'))
const graphPanel = initGraphPanel(document.getElementById('graph-pane'))
const playback = initPlayback(
  document.getElementById('playback-controls'),
  sceneAPI,
  {
    onTick: (i) => {
      tablePanel.highlightIndex(i)
      graphPanel.highlightIndex(i)
    },
  },
)

const { api, store, graphs } = createDSL()
const log = createLog()

// Evaluate the editor's DSL code with the DSL functions injected as globals,
// then refresh the table + graph panels and (re)load "events" into playback.
// `record` appends the run to the session log; replays pass record:false so a
// restored session isn't re-logged as it's being replayed.
function evaluate(code, { setError, record = true } = {}) {
  const seed = randomSeed()
  store.clear()
  graphs.length = 0
  try {
    const fn = new Function(...Object.keys(api), code)
    fn(...Object.values(api))
  } catch (err) {
    setError?.(err.message)
    return
  }
  setError?.(null)
  tablePanel.setTables(store)
  graphPanel.setGraphs(graphs)
  const events = store.get('events')
  playback.load(events ? events.rows : [])

  if (record) {
    log.append({ kind: 'run', code, seed })
    log.persist()
  }
}

const editor = initEditor(document.getElementById('editor-pane'), { onRun: evaluate })

// On load: if a previous session was persisted, restore its latest program and
// replay it (without re-logging). Otherwise run the default doc as a fresh run.
if (log.rehydrate()) {
  const latest = log.last()
  editor.setCode(latest.code)
  evaluate(latest.code, { setError: editor.setError, record: false })
} else {
  editor.run()
}
