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
import type { PhysicsEngineInstance } from './physics.js'

const sceneAPI = initThree(document.getElementById('three-canvas') as HTMLCanvasElement)
const tablePanel = initTablePanel(document.getElementById('table-pane') as HTMLElement)

let currentPlayIndex = 0

const playback = initPlayback(
  document.getElementById('playback-controls') as HTMLElement,
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

let physicsEngine: PhysicsEngineInstance | null = null
const runtime = createRuntime({ physics: () => physicsEngine })
const log = createLog()

const sessionStore = createSessionStore()
let currentSessionId = sessionStore.newId()

import type { Table } from './dsl.js'
import type { GraphSpec } from './graph-panel.js'
import type { Row } from './lineage.js'

let lastViews = new Map<string, Table>()

interface CookedData {
  views: Map<string, Table>
  graphs: GraphSpec[]
  sceneRows: Row[]
  timelineRows: Row[]
  effectRows: Row[]
}

function applyCooked({ views, graphs, sceneRows, timelineRows, effectRows }: CookedData): void {
  lastViews = views
  tablePanel.setTables(views)
  tablePanel.setGraphs(graphs)
  playback.load(sceneRows, timelineRows, effectRows)
}

function persistSession(): void {
  if (!log.length) return
  sessionStore.save(currentSessionId, {
    serialized: log.serialize(),
    tables: [...lastViews.keys()],
  })
  refreshSelector()
}

function refreshSelector(): void {
  sessionSelector.setSessions(sessionStore.list(), currentSessionId)
}

interface EvaluateOptions {
  setError?: ((msg: string | null) => void) | null
  record?: boolean
  persist?: boolean
  seed?: number
}

function evaluate(code: string, { setError, record = true, persist = true, seed = randomSeed() }: EvaluateOptions = {}): void {
  let cooked: CookedData
  try {
    cooked = cookProgram(runtime, code, seed)
  } catch (err) {
    setError?.((err as Error).message)
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

const editor = initEditor(document.getElementById('editor-pane') as HTMLElement, {
  onRun: evaluate,
  getViews: () => lastViews,
  onCaretView: (name) => tablePanel.selectTable(name),
  getPlayIndex: () => currentPlayIndex,
})

function scrubSession(pos: number): void {
  let replayed
  try {
    replayed = replayAt(runtime, log, pos)
  } catch (err) {
    editor.setError((err as Error).message)
    return
  }
  if (!replayed) return
  editor.setError(null)
  editor.setCode(replayed.entry.code)
  applyCooked(replayed)
}

function openSession(id: string): void {
  const serialized = sessionStore.load(id)
  if (serialized == null || !log.load(serialized)) return
  currentSessionId = id
  scrubSession(Math.max(0, log.length - 1))
  sessionBar.setLog(log)
  refreshSelector()
}

function newSession(): void {
  currentSessionId = sessionStore.newId()
  log.clear()
  editor.setCode(defaultProgram)
  evaluate(defaultProgram, { setError: editor.setError, persist: false })
  sessionBar.setLog(log)
  refreshSelector()
}

const editorPane = document.getElementById('editor-pane') as HTMLElement
const sessionBar = initSessionBar({ onScrub: scrubSession })
const sessionSelector = initSessionSelector({ onOpen: openSession, onNew: newSession })
editorPane.insertBefore(sessionBar.el, editorPane.children[1])
editorPane.insertBefore(sessionSelector.el, sessionBar.el)

function firstRun(): void {
  evaluate(editor.getCode(), { setError: editor.setError, persist: false })
  sessionBar.setLog(log)
  refreshSelector()
}

initPhysics()
  .then((engine) => { physicsEngine = engine })
  .catch((err: unknown) => console.error('physics failed to load:', err))
  .finally(firstRun)
