import './style.css'
import { initThree } from './three-scene.js'
import { initEditor, defaultProgram } from './editor.js'
import { initTablePanel, EVENTS_SUFFIX } from './table-panel.js'
import { initPlayback } from './playback.js'
import { initSessionBar } from './session-bar.js'
import { initSessionSelector } from './session-selector.js'
import { SAMPLES } from './samples.js'
import { createRuntime } from './runtime.js'
import { createSessionStore } from './sessions.js'
import { cookProgram, cookTimeline, replayAt } from './replay.js'
import { initPhysics } from './physics.js'
import { createLog, randomSeed } from './log.js'
import { Table } from './dsl.js'
import { createEditableTableStore } from './editable-tables.js'
import type { PhysicsEngineInstance } from './physics.js'
import type { Row } from './lineage.js'

const dataCache = new Map<string, string>()
const editableStore = createEditableTableStore()

function extractDataUrls(code: string): string[] {
  const urls: string[] = []
  for (const m of code.matchAll(/\bdata\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) urls.push(m[1])
  return urls
}

const sceneAPI = initThree(document.getElementById('three-canvas') as HTMLCanvasElement)
const tablePanel = initTablePanel(document.getElementById('table-pane') as HTMLElement, editableStore, {
  // A code-typed cell edits in the main editor: Ctrl-Enter there appends the
  // set-cell event; the store change then re-cooks the program so everything
  // fed by the table (including the visible table itself) catches up.
  onEditCell: (table, rowIndex, col, value) => {
    editor.editCell(`${table}[${rowIndex}].${col}`, value, (text) => {
      editableStore.setCell(table, rowIndex, col, text)
    })
  },
})

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
const runtime = createRuntime({
  physics: () => physicsEngine,
  tapRows: () => tapRows(),
  editableRows: (name, schema, seedRows) => editableStore.ensure(name, schema, seedRows),
})
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

// One-line preview of a program for a table cell (the editor is the real view).
function codePreview(code: string): string {
  const flat = code.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? flat.slice(0, 120) + '…' : flat
}

// The views shown in the table panel, plus:
//  - a live "taps" table of wall-time button presses
//  - the session run log as tables: "code" (the fold — latest run) and
//    "code·events" (every run event) — the same current-state/edit-history
//    pair every editable table gets, since both ride the same event log; the
//    code editor is simply the interactive surface of "code"
//  - each editable table's "name·events" history
// (each only when the program doesn't define a view of that name itself).
function tablesForDisplay(views: Map<string, Table>): Map<string, Table> {
  const display = new Map(views)
  if (!display.has('taps')) display.set('taps', new Table(tapRows()))
  if (liveCode != null && !display.has('code')) {
    display.set('code', new Table([{ seed: liveSeed, code: codePreview(liveCode) }]))
  }
  if (!display.has('code' + EVENTS_SUFFIX)) {
    display.set('code' + EVENTS_SUFFIX, new Table(
      log.all().map((e) => ({ seq: e.seq, t: e.t, kind: e.kind, seed: e.seed, code: codePreview(e.code) })),
    ))
  }
  for (const name of editableStore.listNames()) {
    const key = name + EVENTS_SUFFIX
    if (display.has(key)) continue
    display.set(key, new Table((editableStore.get(name)?.events ?? []).map((r) => ({ ...r }))))
  }
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
  cooking = true
  try {
    timelineRows = cookTimeline(runtime, liveCode, liveSeed)
  } catch {
    return
  } finally {
    cooking = false
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

// True while a cook is running: editable() appends create/schema events during
// the cook itself, and reacting to those would loop the cook forever.
let cooking = false

async function evaluate(code: string, { setError, record = true, persist = true, seed = randomSeed() }: EvaluateOptions = {}): Promise<void> {
  const pending = extractDataUrls(code).filter((u) => !dataCache.has(u))
  if (pending.length) {
    await Promise.all(pending.map(async (url) => {
      try {
        dataCache.set(url, await fetch(url).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.text()
        }))
      } catch (e) {
        setError?.(`Failed to fetch ${url}: ${(e as Error).message}`)
      }
    }))
  }

  let cooked: CookedData
  cooking = true
  try {
    cooked = cookProgram(runtime, code, seed, dataCache)
  } catch (err) {
    setError?.((err as Error).message)
    return
  } finally {
    cooking = false
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

// A table-change event landed (cell edit, add row, …): re-cook the live
// program so views built on the table — and the scene/hydra they feed — follow
// the fold. Not recorded as a run (the program text didn't change; the table
// event log already captured the edit). Coalesced per animation frame, and
// ignored while the cook itself is appending create/schema events.
let storeRefreshScheduled = false
editableStore.onChange(() => {
  if (cooking || storeRefreshScheduled) return
  storeRefreshScheduled = true
  requestAnimationFrame(() => {
    storeRefreshScheduled = false
    if (liveCode != null) {
      void evaluate(liveCode, { setError: editor.setError, record: false, seed: liveSeed })
    } else {
      tablePanel.setTables(tablesForDisplay(lastViews))
    }
  })
})

function scrubSession(pos: number): void {
  let replayed
  cooking = true
  try {
    replayed = replayAt(runtime, log, pos, dataCache)
  } catch (err) {
    editor.setError((err as Error).message)
    return
  } finally {
    cooking = false
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
function openExample(index: number): void {
  const sample = SAMPLES[index]
  if (!sample) return
  currentSessionId = sessionStore.newId()
  log.clear()
  editor.setCode(sample.code)
  void evaluate(sample.code, { setError: editor.setError, persist: false })
  sessionBar.setLog(log)
  refreshSelector()
}

const sessionSelector = initSessionSelector({
  onOpen: openSession,
  onNew: newSession,
  onExample: openExample,
  examples: SAMPLES.map((s) => ({ label: s.name })),
})
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
