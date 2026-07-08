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
import { cookProgram } from './replay.js'
import { initPhysics } from './physics.js'
import { randomSeed } from './event-log.js'
import { Table } from './dsl.js'
import { createEditableTableStore, type ColumnType } from './editable-tables.js'
import { createMidiInput } from './midi.js'
import { createTapLog } from './tap-log.js'
import { connectMultiplayer } from './multiplayer.js'
import type { MultiplayerConnection, MultiplayerStatus } from './multiplayer.js'
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
  if (!editableStore.has('code')) {
    editableStore.ensure('code', CODE_SCHEMA, [{ code, seed }])
    return
  }
  // Skip an identical write so re-applying an unchanged program (e.g. a code-cell
  // Apply, which re-cooks against edited table data but leaves the program text
  // alone) doesn't spam "code·events" with duplicate rows — the run is still
  // recorded, it just carries no new code event.
  const cur = editableStore.get('code')?.rows[0]
  if (cur && cur.code === code && cur.seed === seed) return
  editableStore.setRow('code', 0, { code, seed })
}

// Multiplayer's own pseudo-table (see EditableTableStore.record): an Apply
// pulse per successful evaluate() and a peer-join/peer-leave per connection
// change (the latter authored by the room server — see server/server.ts and
// worker/room.ts), so both ride the exact same store log — and therefore the
// exact same multiplayer sync/replay-on-connect path — as any editable table.
const ACTIVITY_TABLE = 'activity'

// Who's currently in the room, per the "activity" table's peer-join/leave
// history (net per client id — last event wins). Includes this replica once
// its own peer-join round-trips back from the server.
function onlinePeers(): Set<string> {
  const online = new Set<string>()
  for (const e of editableStore.get(ACTIVITY_TABLE)?.events ?? []) {
    const client = e.client as string | undefined
    if (!client) continue
    if (e.kind === 'peer-join') online.add(client)
    else if (e.kind === 'peer-leave') online.delete(client)
  }
  return online
}

// How many runs the session has recorded — the session bar's scrub range. A
// run is an Apply (Ctrl-Enter) bookmark spanning *every* editable table (see
// editableStore.recordRun), not just "code"'s history.
function sessionLength(): number {
  return editableStore.runs().length
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
    // the main editor via cell-target mode. Its "Apply ▶" (Ctrl-Enter) is an
    // explicit apply: commit the cell, then re-cook the program against the
    // edited tables and record a run — keeping the current seed so tweaking a
    // sketch doesn't re-randomize the scene. (Plain inline edits stay pending
    // until an apply; this one is the apply.)
    editor.editCell(`${table}[${rowIndex}].${col}`, value, (text) => {
      editableStore.setCell(table, rowIndex, col, text)
      if (liveCode != null) void evaluate(liveCode, { setError: editor.setError, seed: liveSeed })
    })
  },
})

// Tap-beat: event-sourced like any other table (see tap-log.ts), so it's
// synced over multiplayer the same way. The tap-beat *table* and any tempo are
// derived from the log's fold (see the DSL's taps()/tempo()/beats()). Taps are
// stamped with wall-clock Date.now() (see tap-log.ts), which is what lets
// playback anchor "beat 0" to the tap itself (see Playback.wallAlignedTick
// and TapLog.anchor()) instead of to whenever Play was pressed — that's what
// keeps independently-started (or multiplayer-synced) clients in phase.
const tapLog = createTapLog()
const tapRows = (): Row[] => tapLog.rows()
const tapAnchor = (): number | null => tapLog.anchor()

function recordTap(): void {
  tapLog.tap()
  onTap()
}

function clearTaps(): void {
  if (!tapLog.rows().length) return
  tapLog.clear()
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

// --- multiplayer -----------------------------------------------------------
// A shared room is named in the URL (?room=x). Everyone in it syncs the store
// — one event log covering "code" (the program), its run history, and every
// other editable table — over a WebSocket (see multiplayer.ts); all visible
// state follows from the fold. A room's log is also persisted locally under a
// stable session id, so rejoining resumes the jam even before the server
// answers.
const urlParams = new URLSearchParams(location.search)
const roomName = urlParams.get('room')
let multiplayer: MultiplayerConnection | null = null

const roomSessionId = (room: string): string => 'room:' + room

// The server that serves the app also carries the room socket at /ws;
// ?server= overrides for dev setups where the page comes from esbuild.
function multiplayerUrl(): string {
  const override = urlParams.get('server')
  if (override) return override
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
}

if (roomName) {
  currentSessionId = roomSessionId(roomName)
  const saved = sessionStore.load(currentSessionId)
  if (saved) {
    editableStore.load(saved)
    const savedRuns = sessionStore.runs(currentSessionId)
    if (savedRuns.length) editableStore.setRuns(savedRuns)
    else editableStore.deriveRunsFromCode()
  }
}
// ---------------------------------------------------------------------------

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
  // The session is the whole store's event data plus the run list — see
  // sessions.ts. Serialize the *head* log (a scrubbed replay view mustn't leak
  // into what's saved); editableStore.runs() is always the full run list.
  sessionStore.save(currentSessionId, {
    events: editableStore.serialize(),
    runs: editableStore.runs(),
    tables: [...lastViews.keys()],
  })
  refreshSelector()
}

function refreshSelector(): void {
  sessionSelector.setSessions(sessionStore.list(), currentSessionId)
}

interface EvaluateOptions {
  setError?: ((msg: string | null) => void) | null
  // Persist the session after applying. Off for the initial cook of a fresh
  // session/example, which shouldn't be saved until the user actually edits or
  // runs; the run itself is always recorded either way.
  persist?: boolean
  seed?: number
  // Announce this apply on the "activity" table (see ACTIVITY_TABLE below).
  // Off for the multiplayer reactive call — it's already reacting to someone
  // else's pulse, so echoing our own would round-trip forever between
  // replicas.
  broadcast?: boolean
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

// Apply a program: cook it against the current (head) table state, record a run,
// render, and (unless told otherwise) persist. This is the *only* thing that
// applies pending table edits — inline edits just accumulate until an apply.
async function evaluate(code: string, { setError, persist = true, seed = randomSeed(), broadcast = true }: EvaluateOptions = {}): Promise<void> {
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
    // Applying / cooking always operates on the live head, never a scrubbed
    // replay view — return to head first so ensure() reads (and records against)
    // current table state.
    editableStore.setReplayView(null)
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

    // Write the "code" table row (if the program changed) and record the run —
    // *before* applyCooked renders the table panel below, so its first render
    // already sees "code" (otherwise the onChange reaction that would normally
    // pick up a newly-created table is itself suppressed by `cooking` right now).
    // recordRun snapshots every editable table's log index (including the "code"
    // row just written, and any table the cook above created via ensure) as one
    // Apply bookmark — the unit the session bar scrubs.
    setCodeRow(code, seed)
    editableStore.recordRun()
    if (broadcast) editableStore.record(ACTIVITY_TABLE, 'apply')
    sessionBar.setLog({ length: sessionLength() })
    applyCooked(cooked)
    if (persist) persistSession()
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

// A table-change event landed (cell edit, add row, …). Edits are *pending*:
// they are NOT applied to the running program here — the cooked views and the
// scene keep their last state until the user presses Run/Apply (Ctrl-Enter),
// which re-cooks against the edited tables and records a run. We only refresh
// the table panel so the edit shows in its own editable tab (and name·events
// history), and persist the event data so a not-yet-applied edit still survives
// a reload (a session *is* the store's events now — see sessions.ts — so any
// change needs saving, not just a run). Coalesced per animation frame, and
// ignored while a cook (or our own recording/session load) is in flight.
let storeRefreshScheduled = false
editableStore.onChange(() => {
  if (cooking || storeRefreshScheduled) return
  storeRefreshScheduled = true
  requestAnimationFrame(() => {
    storeRefreshScheduled = false
    tablePanel.setTables(tablesForDisplay(lastViews))
    persistSession()
  })
})

// Scrub to run `pos` — a non-destructive preview that restores *every* editable
// table to its state at that run (editableStore.setReplayView folds the shared
// log up to the run's index) and re-cooks the program that was live then (the
// "code" row at that run). It touches nothing in the head log and records no
// run, so pressing Run afterward forks forward from head as a new run rather
// than rewriting history. The newest position is the live head (replay view
// off), so any edits made since the last Apply stay visible there.
function scrubSession(pos: number): void {
  const runs = editableStore.runs()
  if (runs.length === 0) return
  const clamped = Math.max(0, Math.min(pos, runs.length - 1))
  const atLatest = clamped >= runs.length - 1
  cooking = true
  editableStore.setReplayView(atLatest ? null : runs[clamped])
  let cooked: CookedData
  try {
    const codeRow = editableStore.get('code')?.rows[0]
    if (!codeRow || typeof codeRow.code !== 'string') return
    const code = codeRow.code
    const seed = typeof codeRow.seed === 'number' ? codeRow.seed : 0
    cooked = cookProgram(runtime, code, seed, dataCache)
    liveCode = code
    liveSeed = seed
    editor.setCode(code)
  } catch (err) {
    editor.setError((err as Error).message)
    return
  } finally {
    cooking = false
  }
  editor.setError(null)
  applyCooked(cooked)
}

// Switching sessions while in a room would union the newly-loaded log into the
// room — leave the room first so sessions stay what they were.
function exitRoomMode(): void {
  if (!multiplayer) return
  multiplayer.close()
  multiplayer = null
  const u = new URL(location.href)
  u.searchParams.delete('room')
  history.replaceState(null, '', u)
  chipSolo()
}

function openSession(id: string): void {
  exitRoomMode()
  const events = sessionStore.load(id)
  if (events == null) return
  const ok = quietly(() => editableStore.load(events))
  if (!ok) return
  currentSessionId = id
  // Restore the saved run list; a legacy session that predates runs derives
  // them from "code"'s recorded program history so its history stays scrubbable.
  const savedRuns = sessionStore.runs(id)
  quietly(() => (savedRuns.length ? editableStore.setRuns(savedRuns) : editableStore.deriveRunsFromCode()))
  sessionBar.setLog({ length: sessionLength() })
  scrubSession(Math.max(0, sessionLength() - 1))
  refreshSelector()
}

function newSession(): void {
  exitRoomMode()
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
  exitRoomMode()
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

// The room chip: solo it starts a jam (pick a room, seed it with the current
// session, reload into it); in a room it shows status/peers and leaves on click.
const mpChip = document.createElement('button')
mpChip.className = 'multiplayer-chip'
sessionSelector.el.appendChild(mpChip)

function chipSolo(): void {
  mpChip.classList.remove('connected', 'connecting')
  mpChip.textContent = '⇄ jam'
  mpChip.title = 'start or join a shared room'
}

// Redraws the chip for `status` at the *current* peer count (re-folded from
// the "activity" table each time, not pushed) — called on a connection status
// change and again whenever a peer-join/leave lands. Takes status as a plain
// argument rather than reading `multiplayer` because connectMultiplayer's
// onStatus can fire synchronously during its own call, before the `multiplayer
// = connectMultiplayer(...)` assignment below has completed.
function chipStatus(status: MultiplayerStatus): void {
  if (status === 'closed') return
  const peers = onlinePeers().size
  mpChip.classList.toggle('connected', status === 'connected')
  mpChip.classList.toggle('connecting', status === 'connecting')
  mpChip.textContent = status === 'connected' ? `⇄ ${roomName} · ${peers}` : `⇄ ${roomName} …`
  mpChip.title = status === 'connected'
    ? `in room "${roomName}" (${peers} connected) — click to leave`
    : `connecting to room "${roomName}" — click to leave`
}

mpChip.onclick = () => {
  const u = new URL(location.href)
  if (multiplayer) {
    u.searchParams.delete('room')
  } else {
    const name = prompt('Room name to share this session:')?.trim()
    if (!name) return
    // Seed the room with what's on screen: park the store under the room's
    // session id so the reload (and then the server) picks it up.
    if (editableStore.has('code')) {
      sessionStore.save(roomSessionId(name), {
        events: editableStore.serialize(),
        runs: editableStore.runs(),
        tables: [...lastViews.keys()],
      })
    }
    u.searchParams.set('room', name)
  }
  location.href = u.toString()
}

if (roomName) {
  // Guarantee "activity" exists locally before we ever join: the room server
  // authors peer-join/leave events referencing it (see server/server.ts and
  // worker/room.ts), and if this replica were the very first to create the
  // table — which would otherwise only happen on the first Apply's pulse,
  // well after physics has loaded — the server's peer-join for *this very*
  // connection could arrive canonically before any replica's "create" for
  // the table and get silently dropped by the fold (see editable-tables.ts's
  // applyEvent: a non-create event for an unknown table is a no-op).
  editableStore.record(ACTIVITY_TABLE, 'session-start')

  editableStore.log.onMerge((added) => {
    // Newly-merged events on "activity": an Apply pulse (see evaluate()'s
    // `broadcast` — recordRun is a *local* bookmark, so this pulse is the
    // only shared-log trace of an Apply happening) means treat it like they
    // pressed Apply for us too — re-sync the editor to the (possibly
    // unchanged) "code" row, then evaluate() against the now-merged tables,
    // whatever changed — the code text, some other table, or both.
    // broadcast:false so reacting to their pulse doesn't emit one of our own
    // back at them (that would round-trip forever). A peer-join/leave just
    // needs the chip's count refreshed. A remote edit to any *real* table
    // (including "code", short of an Apply pulse) needs nothing here: the
    // generic onChange reaction above already refreshes the table panel and
    // persists, matching how a local pending edit behaves.
    let applied = false
    let presenceChanged = false
    for (const e of added) {
      if (e.table !== ACTIVITY_TABLE) continue
      if (e.kind === 'apply') applied = true
      else if (e.kind === 'peer-join' || e.kind === 'peer-leave') presenceChanged = true
    }
    if (applied) {
      const latest = editableStore.get('code')?.rows[0] as { code: string; seed: number } | undefined
      if (latest) {
        // evaluate() assumes the editor is already showing the code it's
        // given (true for a local Run) — a remote program needs pushing into
        // the editor ourselves, the same way scrubSession() does for a
        // historical run.
        if (latest.code !== liveCode) editor.setCode(latest.code)
        void evaluate(latest.code, { setError: editor.setError, seed: latest.seed, broadcast: false })
      }
    }
    if (presenceChanged) chipStatus(multiplayer?.status ?? 'connecting')
  })
  // A collaborator's tap arrived: refresh the "taps" table and retime the
  // tempo, same as a local tap (see onTap).
  tapLog.log.onMerge(() => onTap())
  chipStatus('connecting')
  multiplayer = connectMultiplayer({
    url: multiplayerUrl(),
    room: roomName,
    logs: { session: editableStore.log, taps: tapLog.log },
    onStatus: chipStatus,
  })
} else {
  chipSolo()
}

function firstRun(): void {
  if (sessionLength()) {
    // Rejoined a room whose store we already had locally: resume it, don't
    // append a new run.
    scrubSession(sessionLength() - 1)
  } else {
    evaluate(editor.getCode(), { setError: editor.setError, persist: false })
  }
  sessionBar.setLog({ length: sessionLength() })
  refreshSelector()
}

initPhysics()
  .then((engine) => { physicsEngine = engine })
  .catch((err: unknown) => console.error('physics failed to load:', err))
  .finally(firstRun)
