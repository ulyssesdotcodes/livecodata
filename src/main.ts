import './style.css'
import { initThree } from './three-scene.js'
import { initEditor, defaultProgram } from './editor.js'
import { initTablePanel } from './table-panel.js'
import { initPlayback } from './playback.js'
import { initSessionBar } from './session-bar.js'
import { initSessionSelector } from './session-selector.js'
import { createRuntime } from './runtime.js'
import { createSessionStore } from './sessions.js'
import { cookProgram, cookTimeline, replayAt } from './replay.js'
import { initPhysics } from './physics.js'
import { createLog, randomSeed } from './log.js'
import { Table } from './dsl.js'
import type { PhysicsEngineInstance } from './physics.js'
import type { Row } from './lineage.js'

const sceneAPI = initThree(document.getElementById('three-canvas') as HTMLCanvasElement)
const tablePanel = initTablePanel(document.getElementById('table-pane') as HTMLElement)

// Tap-beat: the only state is the raw wall-clock presses. The tap-beat *table*
// and any tempo are derived from these (see the DSL's taps()/tempo()/beats()), so
// there's no dedicated tap-beat class — just data plus record/clear.
const TAP_RESET_GAP_MS = 2000 // a long pause starts a fresh tempo
const TAP_MAX = 16            // keep a rolling window so BPM tracks recent tapping
let tapTimes: number[] = []   // performance.now() timestamps, oldest → newest

// One row per press — { beat, time } (ordinal + seconds since the first tap).
function tapRows(): Row[] {
  const t0 = tapTimes[0] ?? 0
  return tapTimes.map((t, i) => ({ beat: i, time: (t - t0) / 1000 }))
}

function recordTap(): void {
  const now = performance.now()
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > TAP_RESET_GAP_MS) tapTimes = []
  tapTimes.push(now)
  if (tapTimes.length > TAP_MAX) tapTimes = tapTimes.slice(-TAP_MAX)
  onTap()
}

function clearTaps(): void {
  if (!tapTimes.length) return
  tapTimes = []
  onTap()
}

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
    tapControl: { tap: recordTap, clear: clearTaps, rows: tapRows },
  },
)

let physicsEngine: PhysicsEngineInstance | null = null
const runtime = createRuntime({ physics: () => physicsEngine, tapRows: () => tapRows() })
const log = createLog()

const sessionStore = createSessionStore()
let currentSessionId = sessionStore.newId()

import type { GraphSpec } from './graph-panel.js'

let lastViews = new Map<string, Table>()
// The program + seed currently on screen, so a tap can re-cook in place.
let liveCode: string | null = null
let liveSeed = 0

interface CookedData {
  views: Map<string, Table>
  graphs: GraphSpec[]
  sceneRows: Row[]
  timelineRows: Row[]
  effectRows: Row[]
}

// The views shown in the table panel, plus a live "taps" table of wall-time
// button presses (only injected when the program doesn't define one itself).
function tablesForDisplay(views: Map<string, Table>): Map<string, Table> {
  const display = new Map(views)
  if (!display.has('taps')) display.set('taps', new Table(tapRows()))
  return display
}

function applyCooked({ views, graphs, sceneRows, timelineRows, effectRows }: CookedData): void {
  lastViews = views
  tablePanel.setTables(tablesForDisplay(views))
  tablePanel.setGraphs(graphs)
  playback.load(sceneRows, timelineRows, effectRows)
}

// A tap changed the tempo: refresh the "taps" table, then recompute *only* the
// timeline (cheap — physics is reused from the memo) so a beats() timeline adopts
// the new beat length, and retime playback in place. Keeps the last timeline on
// failure.
function onTap(): void {
  tablePanel.setTables(tablesForDisplay(lastViews))
  if (liveCode == null) return
  let timelineRows: Row[]
  try {
    timelineRows = cookTimeline(runtime, liveCode, liveSeed)
  } catch {
    return
  }
  playback.setTimeline(timelineRows)
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
  liveCode = code
  liveSeed = seed
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
  liveCode = replayed.entry.code
  liveSeed = replayed.entry.seed
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
