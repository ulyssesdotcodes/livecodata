import './style.css'
import { initThree } from './three-scene.js'
import { initEditor, defaultProgram } from './editor.js'
import { initTablePanel } from './table-panel.js'
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

let currentPlayIndex = 0

const playback = initPlayback(
  document.getElementById('playback-controls'),
  sceneAPI,
  {
    onTick: (tick, active, srcFrame) => {
      currentPlayIndex = srcFrame
      tablePanel.highlightIndex(srcFrame)
      tablePanel.highlightLineage(active)
    },
    onPlay: () => {
      tablePanel.resetAutoscroll()
    },
  },
)

let physicsEngine = null
const runtime = createRuntime({ physics: () => physicsEngine })
const log = createLog()

const sessionStore = createSessionStore()
let currentSessionId = sessionStore.newId()

let lastViews = new Map()

function applyCooked({ views, graphs, sceneRows, timelineRows, effectRows }) {
  lastViews = views
  tablePanel.setTables(views)
  tablePanel.setGraphs(graphs)
  playback.load(sceneRows, timelineRows, effectRows)
}

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
  getPlayIndex: () => currentPlayIndex,
})

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

function openSession(id) {
  const serialized = sessionStore.load(id)
  if (serialized == null || !log.load(serialized)) return
  currentSessionId = id
  scrubSession(Math.max(0, log.length - 1))
  sessionBar.setLog(log)
  refreshSelector()
}

function newSession() {
  currentSessionId = sessionStore.newId()
  log.clear()
  editor.setCode(defaultProgram)
  evaluate(defaultProgram, { setError: editor.setError, persist: false })
  sessionBar.setLog(log)
  refreshSelector()
}

const editorPane = document.getElementById('editor-pane')
const sessionBar = initSessionBar({ onScrub: scrubSession })
const sessionSelector = initSessionSelector({ onOpen: openSession, onNew: newSession })
editorPane.insertBefore(sessionBar.el, editorPane.children[1])
editorPane.insertBefore(sessionSelector.el, sessionBar.el)

function firstRun() {
  evaluate(editor.getCode(), { setError: editor.setError, persist: false })
  sessionBar.setLog(log)
  refreshSelector()
}

initPhysics()
  .then((engine) => { physicsEngine = engine })
  .catch((err) => console.error('physics failed to load:', err))
  .finally(firstRun)
