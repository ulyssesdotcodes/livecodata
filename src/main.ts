import './style.css'
import { initThree } from './three-scene.js'
import { initHydra } from './hydra-scene.js'
import { initEditor, defaultProgram } from './editor.js'
import { initTablePanel, EVENTS_SUFFIX } from './table-panel.js'
import { initPlayback } from './playback.js'
import { initSessionBar } from './session-bar.js'
import { initSessionSelector } from './session-selector.js'
import { SAMPLES } from './samples.js'
import { createRuntime } from './runtime.js'
import { createSessionStore } from './sessions.js'
import { cookProgram, replayAt } from './replay.js'
import { initPhysics } from './physics.js'
import { randomSeed } from './event-log.js'
import { Table } from './dsl.js'
import { createEditableTableStore, type ColumnType } from './editable-tables.js'
import { createMidiInput } from './midi.js'
import type { PhysicsEngineInstance } from './physics.js'
import type { Row } from './lineage.js'

const dataCache = new Map<string, string>()
const editableStore = createEditableTableStore()

// The main program lives here too, as an editable table named "code" —
// columns `code` (type "code", so the table panel hands clicks on it to the
// editor) and `seed`, always exactly one row. Every Run sets that row in one
// atomic event (setCodeRow); "code·events" (surfaced generically, like any
// other editable table's history) *is* the run history, and a session is
// nothing more than this whole store's serialized events — see sessions.ts.
const CODE_SCHEMA: Record<string, ColumnType> = { code: 'code', seed: 'number' }

function setCodeRow(code: string, seed: number): void {
  if (editableStore.has('code')) editableStore.setRow('code', 0, { code, seed })
  else editableStore.ensure('code', CODE_SCHEMA, [{ code, seed }])
}

// How many runs "code" has recorded — the session bar's scrub range.
function sessionLength(): number {
  return editableStore.get('code')?.events.length ?? 0
}

function extractDataUrls(code: string): string[] {
  const urls: string[] = []
  for (const m of code.matchAll(/\bdata\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) urls.push(m[1])
  return urls
}

const canvasPane = document.getElementById('canvas-pane') as HTMLElement
const threeCanvas = document.getElementById('three-canvas') as HTMLCanvasElement
const hydraCanvas = document.getElementById('hydra-canvas') as HTMLCanvasElement
// Three.js renders the 3D scene into three-canvas; hydra takes that as a source
// texture and post-processes it onto the visible hydra-canvas.
const sceneAPI = initThree(threeCanvas, canvasPane)
const hydraAPI = initHydra(hydraCanvas, threeCanvas)
const tablePanel = initTablePanel(document.getElementById('table-pane') as HTMLElement, editableStore, {
  onEditCell: (table, rowIndex, col, value) => {
    // The "code" cell is the program itself, not a side table: clicking it
    // just syncs the main editor back to the stored value (handy if you've
    // been typing without running yet and want to see/return to what's
    // actually live) — no cell-target mode, no back button.
    if (table === 'code' && col === 'code') {
      if (editor.getCode() !== value) editor.setCode(value)
      return
    }
    // Any other code-typed cell (e.g. a hydra-style sketch column) edits in
    // the main editor via cell-target mode: Ctrl-Enter there appends the
    // set-cell event; the store change then re-cooks the program so
    // everything fed by the table (including the visible table itself)
    // catches up.
    editor.editCell(`${table}[${rowIndex}].${col}`, value, (text) => {
      editableStore.setCell(table, rowIndex, col, text)
    })
  },
})

// Tap-beat: the only state is the raw wall-clock presses. The tap-beat *table*
// and any tempo are derived from these (see the DSL's taps()/tempo()/beats()), so
// there's no dedicated tap-beat class — just data plus record/clear.
// Timestamps are Date.now() (real wall-clock epoch ms), not performance.now()
// (which is relative to this page load and meaningless to compare across a
// reload or another machine) — that's what lets playback anchor "beat 0" to
// the tap itself (see Playback.wallAlignedTick) instead of to whenever Play
// was pressed, which is what keeps independently-started clients in phase.
const TAP_RESET_GAP_MS = 2000 // a long pause starts a fresh tempo
const TAP_MAX = 16            // keep a rolling window so BPM tracks recent tapping
let tapTimes: number[] = []   // Date.now() epoch ms, oldest → newest

// One row per press — { beat, time } (ordinal + seconds since the first tap).
function tapRows(): Row[] {
  const t0 = tapTimes[0] ?? 0
  return tapTimes.map((t, i) => ({ beat: i, time: (t - t0) / 1000 }))
}

// The epoch (ms) "beat 0" is anchored to — the *first* tap of the current
// sequence (a person tapping a tempo starts on beat 1, so that's the tap that
// actually landed on the grid; later taps only refine the interval) — once at
// least two taps have established a tempo. Null otherwise.
function tapAnchor(): number | null {
  return tapTimes.length >= 2 ? tapTimes[0] : null
}

function recordTap(): void {
  const now = Date.now()
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

// Live MIDI: an append-only event log on the shared primitive. Each event is
// stamped with wall time (by the log), the current loop iteration, and the
// playhead's content/source position (Playback.currentSourceBeats) — the
// coordinate the baked scene is keyed to, so a recorded sweep's speed follows
// the timeline mapping. The folded "midi" table (per note, the latest loop's
// take) is what midi("c4") bindings resolve against each frame; the raw log
// shows as "midi·events".
let loopCount = 0
const midiInput = createMidiInput({
  getIndex: () => playback.currentSourceBeats(),
  getLoop: () => loopCount,
  onChange: () => onMidi(),
})

const playback = initPlayback(
  document.getElementById('playback-controls') as HTMLElement,
  sceneAPI,
  hydraAPI,
  {
    onTick: (tick, active, srcBeats) => {
      currentPlayIndex = srcBeats
      tablePanel.highlightIndex(srcBeats)
      tablePanel.highlightLineage(active)
    },
    onPlay: () => {
      tablePanel.resetAutoscroll()
    },
    onLoop: () => { loopCount++ },
    tapControl: { tap: recordTap, clear: clearTaps, rows: tapRows, anchor: tapAnchor },
    midiCtxAt: (srcFrame) => midiInput.ctxAt(srcFrame),
  },
)

// A new MIDI event refreshes the "midi"/"midi·events" display tables. The scene
// itself updates live every rAF tick via the per-frame bindings regardless —
// this refresh is purely cosmetic. Coalesced to once per animation frame: a
// knob sweep can fire 100+ messages/sec, and re-rendering the panel per message
// stalls the main thread.
let midiDisplayScheduled = false
function onMidi(): void {
  if (midiDisplayScheduled) return
  midiDisplayScheduled = true
  requestAnimationFrame(() => {
    midiDisplayScheduled = false
    tablePanel.setTables(tablesForDisplay(lastViews))
  })
}

let physicsEngine: PhysicsEngineInstance | null = null
const runtime = createRuntime({
  physics: () => physicsEngine,
  tapRows: () => tapRows(),
  editableRows: (name, schema, seedRows) => editableStore.ensure(name, schema, seedRows),
})

const sessionStore = createSessionStore()
let currentSessionId = sessionStore.newId()

import type { GraphSpec } from './graph-panel.js'

let lastViews = new Map<string, Table>()
// The program + seed currently on screen (may be a scrubbed historical run,
// not necessarily "code"'s latest row — see scrubSession), so a tap can
// re-cook in place.
let liveCode: string | null = null
let liveSeed = 0

interface CookedData {
  views: Map<string, Table>
  graphs: GraphSpec[]
  sceneRows: Row[]
  timelineRows: Row[]
  hydraRows: Row[]
}

// The views shown in the table panel, plus:
//  - a live "taps" table of wall-time button presses
//  - a live "midi"/"midi·events" pair (streaming input, not an editable table)
//  - every editable table's "name·events" history (this generically covers
//    "code·events" too, now that the program is just another editable table)
// (each only when the program doesn't define a view of that name itself).
function tablesForDisplay(views: Map<string, Table>): Map<string, Table> {
  const display = new Map(views)
  if (!display.has('taps')) display.set('taps', new Table(tapRows()))
  if (!display.has('midi')) display.set('midi', new Table(midiInput.rows()))
  if (!display.has('midi' + EVENTS_SUFFIX)) display.set('midi' + EVENTS_SUFFIX, new Table(midiInput.eventRows()))
  for (const name of editableStore.listNames()) {
    const key = name + EVENTS_SUFFIX
    if (display.has(key)) continue
    display.set(key, new Table((editableStore.get(name)?.events ?? []).map((r) => ({ ...r }))))
  }
  return display
}

function applyCooked({ views, graphs, sceneRows, timelineRows, hydraRows }: CookedData): void {
  lastViews = views
  tablePanel.setTables(tablesForDisplay(views))
  tablePanel.setGraphs(graphs)
  playback.load(sceneRows, timelineRows, hydraRows)
}

// A tap changed the tempo: refresh the "taps" table and re-anchor playback to
// the new tempo. Nothing re-cooks — content sits on a fixed beat grid, so the
// timeline (a tempo-independent beat remap) is unaffected; only the rate the
// playhead sweeps the loop changes.
function onTap(): void {
  tablePanel.setTables(tablesForDisplay(lastViews))
  playback.retempo()
}

function persistSession(): void {
  if (!editableStore.has('code')) return
  sessionStore.save(currentSessionId, {
    events: editableStore.serialize(),
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

// True while a cook — or a store operation we're about to react to ourselves
// (recording a run, loading/clearing a session) — is in progress: editable()
// appends create/schema events during the cook itself, and reacting to those
// (or to our own bookkeeping writes) would loop or double-cook.
let cooking = false

// Run `fn` with the "don't react to my own store changes" guard held, and
// return its result. Used around session load/clear, which notify like any
// other edit but are always immediately followed by an explicit re-cook here.
function quietly<T>(fn: () => T): T {
  cooking = true
  try {
    return fn()
  } finally {
    cooking = false
  }
}

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

  cooking = true
  try {
    let cooked: CookedData
    try {
      cooked = cookProgram(runtime, code, seed, dataCache)
    } catch (err) {
      setError?.((err as Error).message)
      return
    }
    setError?.(null)
    liveCode = code
    liveSeed = seed

    // Record the run — and so create/update the "code" table — *before*
    // applyCooked renders the table panel below, so its first render already
    // sees "code" (otherwise the onChange reaction that would normally pick up
    // a newly-created table is itself suppressed by `cooking` right now).
    if (record) {
      setCodeRow(code, seed)
      sessionBar.setLog({ length: sessionLength() })
    }
    applyCooked(cooked)
    if (record && persist) persistSession()
  } finally {
    cooking = false
  }
}

const editor = initEditor(document.getElementById('editor-pane') as HTMLElement, {
  onRun: evaluate,
  getViews: () => lastViews,
  onCaretView: (name) => tablePanel.selectTable(name),
  getPlayIndex: () => currentPlayIndex,
})

// A table-change event landed (cell edit, add row, …): re-cook the live
// program so views built on the table — and the scene it feeds — follow the
// fold, and persist the session so the edit isn't lost on reload even if the
// user never presses Run afterward (a session *is* the store's events now —
// see sessions.ts — so any change to it needs saving, not just a run). Not
// recorded as a run itself (the program text didn't change; whatever table's
// own event log already captured the edit). Coalesced per animation frame,
// and ignored while a cook (or our own recording/session load) is in flight.
let storeRefreshScheduled = false
editableStore.onChange(() => {
  if (cooking || storeRefreshScheduled) return
  storeRefreshScheduled = true
  requestAnimationFrame(() => {
    storeRefreshScheduled = false
    void (async () => {
      if (liveCode != null) {
        await evaluate(liveCode, { setError: editor.setError, record: false, seed: liveSeed })
      } else {
        tablePanel.setTables(tablesForDisplay(lastViews))
      }
      persistSession()
    })()
  })
})

// Scrub to run `pos` in "code"'s own history (see codeEntryAt in replay.ts) —
// a non-destructive preview: it re-cooks and displays that historical program
// but does not touch the "code" table's row (still the latest run) or record
// anything, so pressing Run afterward forks forward from here as a new run
// rather than rewriting history.
function scrubSession(pos: number): void {
  const events = editableStore.get('code')?.events ?? []
  let replayed
  cooking = true
  try {
    replayed = replayAt(runtime, events, pos, dataCache)
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
  const events = sessionStore.load(id)
  if (events == null) return
  const ok = quietly(() => editableStore.load(events))
  if (!ok) return
  currentSessionId = id
  scrubSession(Math.max(0, sessionLength() - 1))
  sessionBar.setLog({ length: sessionLength() })
  refreshSelector()
}

function newSession(): void {
  currentSessionId = sessionStore.newId()
  quietly(() => editableStore.clear())
  editor.setCode(defaultProgram)
  evaluate(defaultProgram, { setError: editor.setError, persist: false })
  sessionBar.setLog({ length: sessionLength() })
  refreshSelector()
}

const editorPane = document.getElementById('editor-pane') as HTMLElement
const sessionBar = initSessionBar({ onScrub: scrubSession })
function openExample(index: number): void {
  const sample = SAMPLES[index]
  if (!sample) return
  currentSessionId = sessionStore.newId()
  quietly(() => editableStore.clear())
  editor.setCode(sample.code)
  void evaluate(sample.code, { setError: editor.setError, persist: false })
  sessionBar.setLog({ length: sessionLength() })
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
  sessionBar.setLog({ length: sessionLength() })
  refreshSelector()
}

initPhysics()
  .then((engine) => { physicsEngine = engine })
  .catch((err: unknown) => console.error('physics failed to load:', err))
  .finally(firstRun)
