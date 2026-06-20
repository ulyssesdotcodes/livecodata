import './style.css'
import { initThree } from './three-scene.js'
import { initEditor } from './editor.js'
import { initTablePanel } from './table-panel.js'
import { initGraphPanel } from './graph-panel.js'
import { initPlayback } from './playback.js'
import { initSessionBar } from './session-bar.js'
import { createRuntime } from './runtime.js'
import { cookProgram, replayAt } from './replay.js'
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

// Push a cooked result to the panels + playback. Shared by live runs and replay.
function applyCooked({ views, graphs, sceneRows }) {
  tablePanel.setTables(views)
  graphPanel.setGraphs(graphs)
  playback.load(sceneRows)
}

// Cook the editor's program and show it. `record` appends the run to the session
// log (and advances the session bar to latest); replays pass record:false and
// the recorded seed so a restored/replayed run reproduces exactly.
function evaluate(code, { setError, record = true, seed = randomSeed() } = {}) {
  let cooked
  try {
    cooked = cookProgram(runtime, code, seed)
  } catch (err) {
    setError?.(err.message)
    return
  }
  setError?.(null)
  applyCooked(cooked)

  if (record) {
    log.append({ kind: 'run', code, seed })
    log.persist()
    sessionBar.setLog(log)
  }
}

const editor = initEditor(document.getElementById('editor-pane'), { onRun: evaluate })

// Replay the session to a logical position: re-cook the program live then
// (recorded seed) and reflect it in the editor + panels, without re-logging.
function scrubSession(pos) {
  let replayed
  try {
    replayed = replayAt(runtime, log, pos)
  } catch (err) {
    editor.setError(err.message)
    return
  }
  if (!replayed) return
  editor.setError(null)
  editor.setCode(replayed.entry.code)
  applyCooked(replayed)
}

// Mount the session bar just under the editor header (authoring timeline).
const editorPane = document.getElementById('editor-pane')
const sessionBar = initSessionBar({ onScrub: scrubSession })
editorPane.insertBefore(sessionBar.el, editorPane.children[1])

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
sessionBar.setLog(log)

// Debug handle: inspect or reset the session log from the console.
// e.g. livecodata.log.all(); livecodata.resetSession()
window.livecodata = {
  log,
  resetSession() { log.clear(); location.reload() },
}
