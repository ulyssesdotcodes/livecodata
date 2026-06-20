import './style.css'
import { initThree } from './three-scene.js'
import { initEditor } from './editor.js'
import { initTablePanel } from './table-panel.js'
import { initGraphPanel } from './graph-panel.js'
import { initPlayback } from './playback.js'
import { createRuntime } from './runtime.js'
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

const runtime = createRuntime()
const log = createLog()

// Cook the editor's program through the runtime, then refresh the table + graph
// panels and (re)load "events" into playback. `record` appends the run to the
// session log; replays pass record:false (and the recorded seed) so a restored
// session reproduces exactly and isn't re-logged as it's being replayed.
function evaluate(code, { setError, record = true, seed = randomSeed() } = {}) {
  let result
  try {
    result = runtime.run(code, { seed })
  } catch (err) {
    setError?.(err.message)
    return
  }
  setError?.(null)
  tablePanel.setTables(result.views)
  graphPanel.setGraphs(result.graphs)
  const events = result.views.get('events')
  playback.load(events ? events.rows : [])

  if (record) {
    log.append({ kind: 'run', code, seed })
    log.persist()
  }
}

const editor = initEditor(document.getElementById('editor-pane'), { onRun: evaluate })

// On load: if a previous session was persisted, restore its latest program and
// replay it deterministically (recorded seed, without re-logging). Otherwise run
// the default doc as a fresh run.
if (log.rehydrate()) {
  const latest = log.last()
  editor.setCode(latest.code)
  evaluate(latest.code, { setError: editor.setError, record: false, seed: latest.seed })
} else {
  editor.run()
}

// Debug handle: inspect or reset the session log from the console.
// e.g. livecodata.log.all(); livecodata.resetSession()
window.livecodata = {
  log,
  resetSession() { log.clear(); location.reload() },
}
