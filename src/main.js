import './style.css'
import { initThree } from './three-scene.js'
import { initEditor } from './editor.js'
import { initTablePanel } from './table-panel.js'
import { initGraphPanel } from './graph-panel.js'
import { initPlayback } from './playback.js'
import { initSessionBar } from './session-bar.js'
import { createRuntime } from './runtime.js'
import { cookProgram, replayAt } from './replay.js'
import { initPhysics } from './physics.js'
import { createLog, randomSeed } from './log.js'

const sceneAPI = initThree(document.getElementById('three-canvas'))
const tablePanel = initTablePanel(document.getElementById('table-pane'))
const graphPanel = initGraphPanel(document.getElementById('graph-pane'))
const playback = initPlayback(
  document.getElementById('playback-controls'),
  sceneAPI,
  {
    onTick: (tick, active, srcFrame) => {
      // Cursors follow the source frame (what's on screen), so under a remapped
      // timeline the table/graph index bar tracks e.g. f349 when reversed, not
      // the raw tick f10. Without a timeline, srcFrame === tick.
      tablePanel.highlightIndex(srcFrame)
      graphPanel.highlightIndex(srcFrame)
      tablePanel.highlightLineage(active)
      graphPanel.highlightLineage(active)
    },
  },
)

// The Jolt build loads in the background; until it resolves, physics() in the
// DSL throws a friendly "still loading" error. The runtime takes a getter so the
// engine can be slotted in once ready (see firstRun below).
let physicsEngine = null
const runtime = createRuntime({ physics: () => physicsEngine })
const log = createLog()

// The most recent cook's views, exposed to the editor for autocomplete.
let lastViews = new Map()

// Push a cooked result to the panels + playback. Shared by live runs and replay.
function applyCooked({ views, graphs, sceneRows, timelineRows }) {
  lastViews = views
  tablePanel.setTables(views)
  graphPanel.setGraphs(graphs)
  playback.load(sceneRows, timelineRows)
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

const editor = initEditor(document.getElementById('editor-pane'), {
  onRun: evaluate,
  getViews: () => lastViews,
  onCaretView: (name) => tablePanel.selectTable(name),
})

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

// First run. The default program drives a physics bake, so wait for the Jolt
// engine to load before the initial cook (the page shell is already up). If Jolt
// fails to load we still run — only physics() programs will error. On load: if a
// previous session was persisted, restore its latest program and replay it
// deterministically (recorded seed, no re-log); otherwise run the default doc.
function firstRun() {
  if (log.rehydrate()) {
    const latest = log.last()
    editor.setCode(latest.code)
    evaluate(latest.code, { setError: editor.setError, record: false, seed: latest.seed })
  } else {
    editor.run()
  }
  sessionBar.setLog(log)
}

initPhysics()
  .then((engine) => { physicsEngine = engine })
  .catch((err) => console.error('physics failed to load:', err))
  .finally(firstRun)
