import './style.css'
import { initThree } from './three-scene.js'
import { initEditor } from './editor.js'
import { initTablePanel } from './table-panel.js'
import { initGraphPanel } from './graph-panel.js'
import { initPlayback } from './playback.js'
import { createDSL } from './dsl.js'

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

// Evaluate the editor's DSL code with the DSL functions injected as globals,
// then refresh the table + graph panels and (re)load "events" into playback.
function runCode(code, { setError }) {
  store.clear()
  graphs.length = 0
  try {
    const fn = new Function(...Object.keys(api), code)
    fn(...Object.values(api))
  } catch (err) {
    setError(err.message)
    return
  }
  setError(null)
  tablePanel.setTables(store)
  graphPanel.setGraphs(graphs)
  const events = store.get('events')
  playback.load(events ? events.rows : [])
}

const editor = initEditor(document.getElementById('editor-pane'), { onRun: runCode })

// Run once on load so there's something to see.
editor.run()
