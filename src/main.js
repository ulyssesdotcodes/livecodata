import './style.css'
import { initThree } from './three-scene.js'
import { initEditor, defaultProgram } from './editor.js'
import { initTablePanel } from './table-panel.js'
import { initGraphPanel } from './graph-panel.js'
import { initPlayback } from './playback.js'
import { initSessionBar } from './session-bar.js'
import { initSessionSelector } from './session-selector.js'
import { createRuntime } from './runtime.js'
import { createSessionStore } from './sessions.js'
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

// Multiple authoring sessions live in localStorage (see sessions.js). The page
// always opens on a *fresh* session — past sessions are reachable from the
// selector — so this id starts new and is reassigned when one is reopened.
const sessionStore = createSessionStore()
let currentSessionId = sessionStore.newId()

// The most recent cook's views, exposed to the editor for autocomplete.
let lastViews = new Map()

// Push a cooked result to the panels + playback. Shared by live runs and replay.
function applyCooked({ views, graphs, sceneRows, timelineRows }) {
  lastViews = views
  tablePanel.setTables(views)
  graphPanel.setGraphs(graphs)
  playback.load(sceneRows, timelineRows)
}

// Save the live log into the multi-session store under the current id, labeled
// by the latest run's table names, and refresh the selector. Empty logs (a
// session nobody has authored in yet) are skipped so the list stays clean.
function persistSession() {
  if (!log.length) return
  sessionStore.save(currentSessionId, {
    serialized: log.serialize(),
    tables: [...lastViews.keys()],
  })
  refreshSelector()
}

function refreshSelector() {
  sessionSelector.setSessions(sessionStore.list(), currentSessionId)
}

// Cook the editor's program and show it. `record` appends the run to the session
// log (and advances the session bar to latest); replays pass record:false and
// the recorded seed so a restored/replayed run reproduces exactly. `persist`
// also commits the run to the multi-session store — the initial auto-run passes
// persist:false so merely loading the page doesn't spawn a stored session.
function evaluate(code, { setError, record = true, persist = true, seed = randomSeed() } = {}) {
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
    sessionBar.setLog(log)
    if (persist) persistSession()
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

// Reopen a past session from the store: load its serialized log, adopt its id
// (so further edits continue it), and replay to its latest run — reflecting the
// program + panels without re-logging.
function openSession(id) {
  const serialized = sessionStore.load(id)
  if (serialized == null || !log.load(serialized)) return
  currentSessionId = id
  scrubSession(Math.max(0, log.length - 1))
  sessionBar.setLog(log)
  refreshSelector()
}

// Start a fresh session: a new id, an empty log, and the default program. Not
// persisted until the user actually runs something (see evaluate's persist:false
// auto-run), so empty new sessions don't pile up in the selector.
function newSession() {
  currentSessionId = sessionStore.newId()
  log.clear()
  editor.setCode(defaultProgram)
  evaluate(defaultProgram, { setError: editor.setError, persist: false })
  sessionBar.setLog(log)
  refreshSelector()
}

// Mount the session selector and the session bar just under the editor header.
// Selector first (which session), then the authoring timeline within it.
const editorPane = document.getElementById('editor-pane')
const sessionBar = initSessionBar({ onScrub: scrubSession })
const sessionSelector = initSessionSelector({ onOpen: openSession, onNew: newSession })
editorPane.insertBefore(sessionBar.el, editorPane.children[1])
editorPane.insertBefore(sessionSelector.el, sessionBar.el)

// First run. The default program drives a physics bake, so wait for the Jolt
// engine to load before the initial cook (the page shell is already up). If Jolt
// fails to load we still run — only physics() programs will error. The page
// always opens on a fresh session (default = new); the auto-run isn't persisted,
// so the session is committed to the store only once the user runs their code.
function firstRun() {
  evaluate(editor.getCode(), { setError: editor.setError, persist: false })
  sessionBar.setLog(log)
  refreshSelector()
}

initPhysics()
  .then((engine) => { physicsEngine = engine })
  .catch((err) => console.error('physics failed to load:', err))
  .finally(firstRun)