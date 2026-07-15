import './style.css'
import { createSignal } from 'solid-js'
import { initThree } from './three-scene.js'
import { initHydra } from './hydra-scene.js'
import { isHydraRow } from './hydra.js'
import { createSceneVisualizer, createHydraVisualizer } from './visualizer.js'
import { mountApp } from './ui/app.js'
import { createEditor, defaultProgram, defaultTables, PROGRAM_CELL } from './ui/editor.js'
import { createTablePanel } from './ui/table-panel.js'
import { EVENTS_SUFFIX } from './table-panel.js'
import { createPlaybackController, type PlaybackController } from './ui/playback-controls.js'
import { createSessionBar } from './ui/session-bar.js'
import { createSessionSelector } from './ui/session-selector.js'
import { createRoomChip } from './ui/room-chip.js'
import { SAMPLES } from './samples.js'
import { defaultSessionStore } from './sessions.js'
import { getVimMode, setVimMode, getMidiEnabled, setMidiEnabled, getUsername, setUsername } from './settings.js'
import { createCookClient } from './cook-client.js'
import { randomSeed, localSource } from './event-log.js'
import { createPresenceChannel, userColor, lastCellEdits } from './presence.js'
import { Table } from './dsl.js'
import { createEditableTableStore, DISABLED_COL, CLEAR_RUNS_KIND, ACTIVITY_TABLE, type ColumnType, type SessionRun } from './editable-tables.js'
import type { ApplyNode } from './branches.js'
import { createMidiInput, subscribeWebMidi, type MidiInput, type MidiStore } from './midi.js'
import { createSliderInput, sliderDefs, type SliderInput, type SliderStore } from './sliders.js'
import { createSliderPanel } from './ui/slider-panel.js'
import { beatToFrame } from './constants.js'
import { createTapLog } from './tap-log.js'
import { connectMultiplayer } from './multiplayer.js'
import type { MultiplayerConnection, MultiplayerStatus } from './multiplayer.js'
import { PRESENCE_LOG } from './room-core.js'
import { loopEpochsFromApplies } from './playback.js'
import type { PlaybackAPI, PlaybackOptions } from './playback.js'
import type { Row } from './lineage.js'
import type { PeerPresence } from './ui/table-panel.js'

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
// commit per successful evaluate() and a peer-join/peer-leave per connection
// change (the latter authored by the room server — see server/server.ts and
// worker/room.ts), so both ride the exact same store log — and therefore the
// exact same multiplayer sync/replay-on-connect path — as any editable table.
// ACTIVITY_TABLE is exported from editable-tables so the apply node the branch
// tree folds and its consumers here name the same table.

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

// --- multiplayer identity & presence ----------------------------------------
// The room and this player's display name both ride the URL (?room=x&user=me),
// so a reload rejoins the same room as the same person; the name is also
// remembered (settings.ts) to prefill the join popover next time. Presence —
// which table tab each player has open, which code cell their editor is on
// and where their cursor sits — rides its own synced log (see presence.ts),
// deliberately separate from the store log so cursor chatter never lands in
// the persisted session or its scrubbable history.
const urlParams = new URLSearchParams(location.search)
const roomName = urlParams.get('room')
const userName = (urlParams.get('user') ?? '').trim() || getUsername()
if (roomName && (urlParams.get('user') ?? '').trim()) setUsername(userName)

const presence = roomName ? createPresenceChannel({ user: userName }) : null

// A peer's display name (their announced username, or a short replica id for
// the anonymous) and stable color, keyed by name so it survives reloads.
const peerLabel = (client: string, user: string): string => user || client.slice(0, 6)
const peerColor = (client: string, user: string): string => userColor(user || client)

// How many applies the current branch has — the session bar's scrub range. An
// apply (Ctrl-Enter) commits a batch of edits spanning *every* editable table
// (see editableStore.recordApply). A branching session scrubs its current
// branch path; a legacy session with no apply nodes falls back to its linear
// run list, exactly as before.
function sessionLength(): number {
  return editableStore.currentHead() === null
    ? editableStore.runs().length
    : editableStore.branchPath().length
}

function extractDataUrls(code: string): string[] {
  const urls: string[] = []
  for (const m of code.matchAll(/\bdata\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) urls.push(m[1])
  return urls
}

// The playback engine, assigned once the app has mounted (it needs the
// scene/hydra APIs, which need the canvases the app render creates — see the
// mountApp call below). Everything that touches it does so from callbacks
// that can only fire after this module has finished evaluating.
let playback: PlaybackAPI

const tablePanel = createTablePanel(editableStore, {
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
    // the main editor via cell-target mode. Its "Apply" (Ctrl-Enter) is an
    // explicit apply: commit the cell, then re-cook the program against the
    // edited tables and record a run — keeping the current seed so tweaking a
    // sketch doesn't re-randomize the scene. (Plain inline edits stay pending
    // until an apply; this one is the apply.)
    // Which language surface the editor should run completions/hover against
    // for this cell: the code column's declared language wins (editable(name,
    // { code: { type: "code", language: "hydra" } }) — the only signal that
    // survives the rows being mapped/renamed into the "hydra" view by code).
    // Tables declared before language existed fall back to sniffing the row:
    // a hydra event row's `code` cell is a sketch.
    const data = editableStore.get(table)
    const colSpec = data?.columns.find((c) => c.name === col)
    const declaredLang = colSpec?.type === 'code' ? colSpec.language : undefined
    const lang = declaredLang
      ?? (col === 'code' && isHydraRow(data?.rows[rowIndex]) ? 'hydra' as const : 'dsl' as const)
    editor.editCell(`${table}[${rowIndex}].${col}`, value, (text) => {
      editableStore.setCell(table, rowIndex, col, text)
      if (liveCode != null) void evaluate(liveCode, { setError: editor.setError, seed: liveSeed })
    }, { lang })
  },
  onCtrlEnter: () => editor.run(),
  onSelectTable: (name) => {
    presence?.set({ table: name })
    schedulePresenceRefresh()
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

// Live MIDI: exactly the same wiring as sliders below — an append-only event
// stream riding the shared editable-table store (a thin MidiStore adapter over
// editableStore.record('midi', …)), so recorded MIDI syncs over multiplayer
// and persists in the session like any other table. Each event is stamped
// with wall time (by the log), the current loop iteration, and the playhead's
// content/source position (Playback.currentSourceBeats) — the coordinate the
// baked scene is keyed to, so a recorded sweep's speed follows the timeline
// mapping. The folded "midi" table (per note, the latest loop's take) is what
// midi("c4") bindings resolve against each frame; the raw log shows as
// "midi·events".
//
// Only the *hardware* side is opt-in (see settings.ts): requesting Web MIDI
// access pops a browser permission prompt, so subscribeWebMidi only runs once
// the user enables the toggle in the editor's settings popover. The input
// itself (fold + playback bindings) always exists, so MIDI recorded by a room
// peer — or loaded from a saved session — plays back regardless of the toggle.
let loopCount = 0
// Whether the reset button's rewind is armed — see toggleRewind/stopRewind
// below. Stepping itself happens in onTick, every REWIND_STEP_BEATS of
// playhead beats (see lastTick/rewindBaseline).
let rewinding = false
const REWIND_STEP_BEATS = 2
// The playhead beat (onTick's `tick`, pre-timeline) last reported — kept live
// regardless of rewinding so arming always steps from "now", not from 0.
let lastTick = 0
// The playhead beat rewindBaseline was last reset to; stepRewind fires once
// tick has advanced REWIND_STEP_BEATS past it. A loop wrap (tick dropping
// below the baseline) just re-bases here rather than tracking cross-wrap
// distance — worst case that delays one step by less than a loop.
let rewindBaseline = 0
let midiEnabled = getMidiEnabled()

const midiStore: MidiStore = {
  record: (kind, payload) => editableStore.record('midi', kind, payload),
  events: () => editableStore.log.all().filter((e) => e.table === 'midi'),
  onChange: (cb) => editableStore.onChange(cb),
}

const midiInput: MidiInput = createMidiInput({
  store: midiStore,
  getIndex: () => playback.currentSourceBeats(),
  getLoop: () => loopCount,
})

// Attach the hardware exactly once, however the toggle is flipped around.
let midiSubscribed = false
function ensureMidiSubscription(): void {
  if (midiSubscribed) return
  midiSubscribed = true
  subscribeWebMidi(midiInput)
}

if (midiEnabled) ensureMidiSubscription()

// On-screen sliders: the twin of MIDI, but the "controller" is drawn over the
// visual (see ui/slider-panel.tsx). Which sliders exist and their min/max come
// from the program (a view named "sliders", rows { id, min, max, default? }); a
// slider's value changes ride an event log stamped with the source position, so
// a recorded move replays every loop and slider("id") bindings resolve against
// it each frame. Unlike MIDI, that log is the shared editable-table store, not a
// private one — slider moves are ordinary "slider" store events, so they sync
// over multiplayer and persist in the session like any other table (this adapter
// is the whole of that wiring). And unlike MIDI there's no browser permission to
// request, so the input is created the moment a program defines a slider.
const sliderStore: SliderStore = {
  record: (kind, payload) => editableStore.record('slider', kind, payload),
  events: () => editableStore.log.all().filter((e) => e.table === 'slider'),
  onChange: (cb) => editableStore.onChange(cb),
}

let sliderInput: SliderInput | null = null

function ensureSliderInput(): SliderInput {
  if (!sliderInput) {
    sliderInput = createSliderInput({
      store: sliderStore,
      getIndex: () => playback.currentSourceBeats(),
    })
  }
  return sliderInput
}

// The slider overlay controller. Its callbacks drive the log: grabbing a slider
// clears its old take (record anew), each move records a value at the current
// playhead, and releasing hands the thumb back to the recorded automation.
// Recording through the store means the generic store onChange handler already
// refreshes the "slider"/"slider·events" tables and persists the session — no
// separate refresh needed. Created before mountApp (which renders it); the
// callbacks only fire on user interaction, well after `playback` lands.
const sliderPanel = createSliderPanel({
  onGrab: (id) => ensureSliderInput().clearId(id),
  onInput: (id, value) => ensureSliderInput().set(id, value),
  onRelease: () => {},
})

// Push the slider definitions (the "sliders" table) to both the overlay and the
// streaming input, on every cook. Prefer the cooked view — a program that
// computes it or declares it with editable("sliders", …) — but fall back to the
// editable store so a "sliders" table created by hand in the table panel (which
// the program never references, so the cook doesn't surface it as a view) still
// drives the sliders. Empty when neither exists — the overlay hides and the
// input goes dormant.
function updateSliderDefs(views: Map<string, Table>): void {
  // The cooked view (if any) already reflects ensure()'s filtering; the raw
  // fallback (a table-panel-only "sliders" table) needs it applied here too,
  // so a row disabled via its own `disabled` column doesn't drive a live slider.
  const rows = views.get('sliders')?.rows ?? (editableStore.get('sliders')?.rows ?? []).filter((r) => r[DISABLED_COL] !== true)
  const defs = sliderDefs(rows)
  sliderPanel.setDefs(defs)
  if (defs.length) ensureSliderInput().setDefs(defs)
  else sliderInput?.setDefs(defs)
}

// Options for the playback engine created after mount (see mountApp below);
// the controller lands in this signal, which the app render watches to show
// the transport controls.
const [playbackCtl, setPlaybackCtl] = createSignal<PlaybackController | null>(null)
const playbackOptions: PlaybackOptions = {
  onTick: (tick, active, srcBeats) => {
    currentPlayIndex = srcBeats
    tablePanel.highlightIndex(srcBeats)
    tablePanel.highlightLineage(active)
    // Move each slider's thumb to its recorded value at the playhead (skipping
    // any the user is currently dragging — see SliderPanel), so the loop's
    // automation is visible on the controls, not just in the visual.
    if (sliderInput && sliderInput.defs().length) {
      sliderPanel.showValues(sliderInput.valuesAt(beatToFrame(srcBeats)))
    }
    lastTick = tick
    if (rewinding) {
      if (tick < rewindBaseline) rewindBaseline = tick
      else if (tick - rewindBaseline >= REWIND_STEP_BEATS) {
        rewindBaseline += REWIND_STEP_BEATS
        stepRewind()
      }
    }
  },
  onPlay: () => {
    tablePanel.resetAutoscroll()
  },
  onLoop: () => { loopCount++ },
  tapControl: { tap: recordTap, clear: clearTaps, rows: tapRows, anchor: tapAnchor },
  // Recorded MIDI drives bindings whenever any exists — the recording may be a
  // peer's (synced through the store) or a saved session's, so this doesn't
  // gate on the local hardware toggle, mirroring sliders below.
  midiCtxAt: (srcFrame) => (midiInput.rows().length ? midiInput.ctxAt(srcFrame) : null),
  sliderCtxAt: (srcFrame) => (sliderInput && sliderInput.defs().length ? sliderInput.ctxAt(srcFrame) : null),
}

// (A new MIDI event needs no dedicated display refresh: it's a store event
// now, so the generic store onChange handler below already refreshes the
// "midi"/"midi·events" tables — coalesced per animation frame, which matters
// for a knob sweep firing 100+ messages/sec. The scene itself updates live
// every rAF tick via the per-frame bindings regardless.)

// The cook — DSL evaluation, materialize, physics baking, rasterize — runs in
// a Web Worker (see cook-worker.ts) so a heavy Apply, local or from a room
// peer, never blocks this thread's rendering and input. Jolt's WASM loads in
// the worker too; this thread never touches it. The store stays here: each
// cook request carries a rows snapshot (read through any active replay view,
// exactly what ensure() would serve), and editable() declarations come back as
// data that the real ensure() below turns into store events as always.
const cookClient = createCookClient(new Worker(new URL('cook-worker.js', import.meta.url), { type: 'module' }))

async function cookInWorker(code: string, seed: number, seeds?: Record<string, Row[]>): Promise<{ cooked: CookedData; declaredNames: string[] }> {
  const editables = editableStore.listNames().map((name) => ({
    name,
    // Match ensure()'s own filtering: a row whose own `disabled` column is
    // true stays in the table but is omitted from what the program sees.
    rows: (editableStore.get(name)?.rows ?? []).filter((r) => r[DISABLED_COL] !== true),
  }))
  const { cooked, declared } = await cookClient.cook({ code, seed, dataCache, tapRows: tapRows(), editables, seeds })
  for (const d of declared) editableStore.ensure(d.name, d.schema, d.seedRows)
  return { cooked, declaredNames: declared.map((d) => d.name) }
}

const sessionStore = defaultSessionStore()
let currentSessionId = sessionStore.newId()

// --- multiplayer -----------------------------------------------------------
// A shared room is named in the URL (?room=x). Everyone in it syncs the store
// — one event log covering "code" (the program), its run history, and every
// other editable table — over a WebSocket (see multiplayer.ts); all visible
// state follows from the fold. A room's log is also persisted locally under a
// stable session id, so rejoining resumes the jam even before the server
// answers.
let multiplayer: MultiplayerConnection | null = null

const roomSessionId = (room: string): string => 'room:' + room

// The server that serves the app also carries the room socket at /ws;
// ?server= overrides for dev setups where the page comes from esbuild.
function multiplayerUrl(): string {
  const override = urlParams.get('server')
  if (override) return override
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
}

// The room's locally-persisted log is restored in boot() (the session store
// is async) — only the id needs pinning before anything could save under it.
if (roomName) currentSessionId = roomSessionId(roomName)
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
//  - a log table's (e.g. "activity") own events, shown directly under its bare
//    name instead of a "name·events" companion — it has no fold state worth a
//    separate interactive tab (see EditableTableStore.isLog).
// (each only when the program doesn't define a view of that name itself).
function tablesForDisplay(views: Map<string, Table>): Map<string, Table> {
  const display = new Map(views)
  if (!display.has('taps')) display.set('taps', new Table(tapRows()))
  // The folded MIDI take ("midi") and its raw log ("midi·events"), once
  // anything has been recorded — locally, by a peer (synced through the
  // store), or in the loaded session. The "midi" store log table itself is
  // suppressed below, same as "slider": these are its only surface.
  if (midiInput.rows().length) {
    if (!display.has('midi')) display.set('midi', new Table(midiInput.rows()))
    if (!display.has('midi' + EVENTS_SUFFIX)) display.set('midi' + EVENTS_SUFFIX, new Table(midiInput.eventRows()))
  }
  // The folded slider automation ("slider") and its raw log ("slider·events"),
  // but only once something has actually been recorded — an empty pair just
  // clutters the panel (and can't be deleted, being synthetic). The "slider"
  // store log table is suppressed below so it never leaks as a raw tab; these
  // are its only surface, and they come and go with the recorded automation.
  // ("sliders" itself is the definitions table, shown like any other view.)
  if (sliderInput && sliderInput.rows().length) {
    display.set('slider', new Table(sliderInput.rows()))
    display.set('slider' + EVENTS_SUFFIX, new Table(sliderInput.eventRows()))
  }
  for (const name of editableStore.listNames()) {
    // The "slider" and "midi" log tables are the backing stores for recorded
    // automation, an implementation detail — each is surfaced (folded) above,
    // or not at all.
    if (name === 'slider' || name === 'midi') continue
    const key = editableStore.isLog(name) ? name : name + EVENTS_SUFFIX
    if (display.has(key)) continue
    display.set(key, new Table((editableStore.get(name)?.events ?? []).map((r) => ({ ...r }))))
  }
  return display
}

// Signature of one cooked output, to detect which of scene/timeline/hydra a
// run actually changed. Functions on rows (easings, streaming bindings) hash
// by their source text — every cook builds fresh closures, so identity would
// always differ while the content is the same.
function cookedSig(rows: Row[]): string {
  return JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'function' ? String(v) : v))
}

const lastCookedSigs = { scene: '', timeline: '', hydra: '' }

// Which cooked outputs differ from what's currently showing (and re-baseline
// the signatures for the next diff) — the determination stamped onto the apply
// pulse so the whole room resets the same multi-loop sequences.
function diffCooked({ sceneRows, timelineRows, hydraRows }: CookedData): { scene: boolean; timeline: boolean; hydra: boolean } {
  const sigs = { scene: cookedSig(sceneRows), timeline: cookedSig(timelineRows), hydra: cookedSig(hydraRows) }
  const changed = {
    scene: sigs.scene !== lastCookedSigs.scene,
    timeline: sigs.timeline !== lastCookedSigs.timeline,
    hydra: sigs.hydra !== lastCookedSigs.hydra,
  }
  Object.assign(lastCookedSigs, sigs)
  return changed
}

// Render a cooked program and hand its rows to playback. The loop epochs ride
// along from the activity table's apply stamps (loopEpochsFromApplies) — the
// author's absolute clock, NOT this replica's — so every client in the room,
// including one that joins later and replays the same events, lands on the
// same pass of a multi-loop sequence.
function applyCooked(cooked: CookedData): void {
  lastViews = cooked.views
  // Refresh slider defs before load(): load() reconciles the scene and fires
  // onTick, which reads the slider input for the thumb values.
  updateSliderDefs(cooked.views)
  tablePanel.setTables(tablesForDisplay(cooked.views))
  tablePanel.setGraphs(cooked.graphs)
  playback.load({ ...cooked, loopEpochs: loopEpochsFromApplies(editableStore.get(ACTIVITY_TABLE)?.events ?? []) })
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
  // A failed save is surfaced on the editor's error strip — a save silently
  // failing is exactly how session data gets lost.
  void sessionStore.save(currentSessionId, {
    events: editableStore.serialize(),
    runs: editableStore.runs(),
    tables: [...lastViews.keys()],
  })
    .then(refreshSelector)
    .catch((err) => editor.setError(`Session save failed: ${(err as Error).message}`))
}

function refreshSelector(): void {
  void sessionStore.list()
    .then((sessions) => sessionSelector.setSessions(sessions, currentSessionId))
    .catch(() => { /* listing is cosmetic — never block on it */ })
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
  // Drop the cooked result (write nothing, render nothing) if the store's
  // program changed while the cook was in flight. The cook awaits a worker
  // (whose first run also boots jolt's WASM), so a fresh client joining a room
  // can have the room's snapshot merge in mid-cook — and firstRun's
  // speculative cook of the default program must NOT then write that default
  // over the room's program (its post-merge event would win the fold on every
  // replica). The merge's own apply reaction renders the room program instead.
  obsoleteIfProgramChanged?: boolean
  // Seed rows for editable tables the store hasn't seen yet, keyed by table
  // name — passed through to the cook so a program's editable(name, schema)
  // call can carry its column schema only, with the row data seeded from here
  // (see openExample: an example's table data lives with the sample, not inline
  // in the code). Only takes effect on the first cook of a fresh store; once a
  // table exists its own rows win, so user edits are never overwritten.
  seeds?: Record<string, Row[]>
}

// True while a cook — or a store operation we're about to react to ourselves
// (recording a run, loading/clearing a session) — is in progress: editable()
// appends create/schema events during the cook itself, and reacting to those
// (or to our own bookkeeping writes) would loop or double-cook. A counter
// rather than a boolean because cooks now await the worker, so two can
// overlap — the guard must hold until the last one finishes.
let cooking = 0

// Run `fn` with the "don't react to my own store changes" guard held, and
// return its result. Used around session load/clear, which notify like any
// other edit but are always immediately followed by an explicit re-cook here.
function quietly<T>(fn: () => T): T {
  cooking++
  try {
    return fn()
  } finally {
    cooking--
  }
}

// Apply a program: cook it against the current (head) table state, record a run,
// render, and (unless told otherwise) persist. This is the *only* thing that
// applies pending table edits — inline edits just accumulate until an apply.
async function evaluate(code: string, { setError, persist = true, seed = randomSeed(), broadcast = true, obsoleteIfProgramChanged = false, seeds }: EvaluateOptions = {}): Promise<void> {
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

  stopRewind()
  cooking++
  try {
    // Applying while scrubbed back forks: promote the scrubbed branch to a live
    // (forked) head *now*, so the cook's ensure()/setRow appends land on it and
    // recordApply commits a forking child of the scrubbed apply. A reactive
    // evaluate (broadcast:false, reacting to a peer's apply) must not fork — it
    // returns to the head the merge already moved us to. At the live head both
    // are no-ops (no replay active).
    if (broadcast) editableStore.forkFromReplay()
    else editableStore.setReplayView(null)
    let cooked: CookedData
    let declaredNames: string[]
    try {
      ({ cooked, declaredNames } = await cookInWorker(code, seed, seeds))
    } catch (err) {
      setError?.((err as Error).message)
      return
    }
    if (obsoleteIfProgramChanged) {
      const current = editableStore.get('code')?.rows[0]?.code
      if (typeof current === 'string' && current !== code) return
    }
    setError?.(null)
    liveCode = code
    liveSeed = seed

    // A table the program used to declare with editable() but no longer does
    // should stop being editable — drop it so a computed view of the same name
    // (or nothing) takes over. Only in the real apply path: a scrubbed replay
    // is a read-only preview and retainDeclared no-ops there anyway.
    editableStore.retainDeclared(declaredNames)

    // Write the "code" table row (if the program changed) — *before* applyCooked
    // renders the table panel below, so its first render already sees "code"
    // (otherwise the onChange reaction that would normally pick up a newly-
    // created table is itself suppressed by `cooking` right now).
    setCodeRow(code, seed)
    // Commit this batch of edits as an apply node — the branch commit that *is*
    // the run (recordApply supersedes recordRun + the separate apply pulse). It
    // claims every pending edit (the "code" row just written, any table the cook
    // created via ensure), stamps which cooked outputs changed and the instant,
    // and — BEFORE applyCooked — so the loop epochs it folds
    // (loopEpochsFromApplies) already include this apply, re-basing this replica
    // from the very stamp its peers will. A reactive evaluate (broadcast:false)
    // commits nothing: the author's apply is already merged into the fold, and
    // the store's onMerge has already followed it to become our head.
    const changed = diffCooked(cooked)
    if (broadcast) {
      const changedKinds = Object.keys(changed).filter((k) => changed[k as keyof typeof changed])
      editableStore.recordApply({ changed: changedKinds, at: Date.now() })
    }
    sessionBar.setLog({ length: sessionLength() })
    applyCooked(cooked)
    if (persist) persistSession()
  } finally {
    cooking--
  }
}

// The code cell this editor is a window onto right now (ui/editor.tsx's
// onCursor labels; "code[0].code" is the main program) — peers' cursors are
// drawn only when they're on this same cell.
let localCell: string = PROGRAM_CELL

const editor = createEditor({
  onRun: evaluate,
  getViews: () => lastViews,
  onCaretView: (name) => tablePanel.selectTable(name),
  getPlayIndex: () => currentPlayIndex,
  vimMode: getVimMode(),
  onVimModeChange: setVimMode,
  midiEnabled,
  onMidiEnabledChange: (enabled) => {
    midiEnabled = enabled
    setMidiEnabled(enabled)
    if (enabled) ensureMidiSubscription()
    tablePanel.setTables(tablesForDisplay(lastViews))
  },
  onResetHydra: () => hydraAPI.reinit(),
  onCursor: (cell, head) => {
    const cellChanged = cell !== localCell
    localCell = cell
    presence?.set({ cell, head })
    // Switching cells changes which remote cursors are visible *here*; plain
    // cursor moves only change what peers see of us.
    if (cellChanged) schedulePresenceRefresh()
  },
  // Live typing: announce the in-progress buffer (throttled in presence.ts)
  // so peers watching this cell can mirror it before it is ever Run.
  onEdit: (cell, code) => presence?.setLiveCode(cell, code),
})

// --- presence indicators -----------------------------------------------------
// Fold the presence log + the store log into per-peer indicators and hand them
// to the table panel (a color ring on the tab each peer has open, an outline
// on the last cell they edited when it's on the shown table) and the editor
// (remote cursors, for peers on the same code cell). Only peers currently
// online (per the "activity" table's join/leave history) are shown. Coalesced
// per animation frame — cursor announcements and merges arrive much faster
// than a redraw is worth.
let presenceRefreshScheduled = false
function schedulePresenceRefresh(): void {
  if (!presence || presenceRefreshScheduled) return
  presenceRefreshScheduled = true
  requestAnimationFrame(() => {
    presenceRefreshScheduled = false
    refreshPresenceUI()
  })
}

// --- live typing view --------------------------------------------------------
// Mirror a collaborator's in-progress buffer (their throttled 'live-code'
// announcements — see presence.ts) into our editor, so watching a peer type
// doesn't wait for their Run. Strictly display: nothing cooks until an Apply
// pulse arrives (the onMerge reaction below), and we only mirror while our own
// buffer is pristine — equal to the last applied program or to the last text
// we mirrored — so a local edit in progress is never clobbered. Only the main
// program cell mirrors: a cell editor (editCell) owns its buffer until
// committed. With several people typing at once the newest announcement wins,
// same last-wins rule as every other presence fold.
let mirroredLiveCode: string | null = null
function followLiveCode(): void {
  if (!presence || localCell !== PROGRAM_CELL) return
  const online = onlinePeers()
  const me = localSource()
  let best: { code: string; seq: number } | null = null
  for (const [client, lc] of presence.liveCodes()) {
    if (client === me || !online.has(client) || lc.cell !== PROGRAM_CELL) continue
    if (!best || lc.seq > best.seq) best = { code: lc.code, seq: lc.seq }
  }
  if (!best) return
  const current = editor.getCode()
  if (best.code === current) return
  if (current !== liveCode && current !== mirroredLiveCode) return
  mirroredLiveCode = best.code
  editor.setCode(best.code)
}

function refreshPresenceUI(): void {
  if (!presence) return
  followLiveCode()
  const online = onlinePeers()
  const me = localSource()
  const edits = lastCellEdits(editableStore.log.all())
  const peers: PeerPresence[] = [...presence.peers().values()]
    .filter((p) => p.client !== me && online.has(p.client))
    .map((p) => {
      const edit = edits.get(p.client)
      return {
        client: p.client,
        user: peerLabel(p.client, p.user),
        color: peerColor(p.client, p.user),
        table: p.table,
        lastEdit: edit ? { table: edit.table, row: edit.row, col: edit.col } : null,
      }
    })
  tablePanel.setPresence(peers)
  editor.setRemoteCursors(
    [...presence.peers().values()]
      .filter((p) => p.client !== me && online.has(p.client) && p.cell != null && p.cell === localCell)
      .map((p) => ({ client: p.client, user: peerLabel(p.client, p.user), color: peerColor(p.client, p.user), head: p.head })),
  )
}

presence?.onChange(schedulePresenceRefresh)

// A table-change event landed (cell edit, add row, slider move, MIDI note, …).
// Edits are *pending*: they are NOT applied to the running program here — the
// cooked views and the scene keep their last state until the user presses
// Run/Apply (Ctrl-Enter), which re-cooks against the edited tables and records
// a run. Live edits ride the log — so they sync over multiplayer instantly —
// but are deliberately NOT persisted here: a session on disk only advances on
// Apply (see evaluate's persistSession), so what's saved is always an applied
// state, never a half-finished edit batch. We only refresh the table panel so
// the edit shows in its own editable tab (and name·events history). Coalesced
// per animation frame, and ignored while a cook (or our own recording/session
// load) is in flight.
let storeRefreshScheduled = false
editableStore.onChange(() => {
  if (cooking || storeRefreshScheduled) return
  storeRefreshScheduled = true
  requestAnimationFrame(() => {
    storeRefreshScheduled = false
    tablePanel.setTables(tablesForDisplay(lastViews))
    // A store event may be a peer's set-cell — their "last edited" marker.
    schedulePresenceRefresh()
  })
})

// Disarm the reset button's rewind, if armed — called wherever the user takes
// back control of the timeline (a manual scrub, or applying new code).
function stopRewind(): void {
  if (!rewinding) return
  rewinding = false
  sessionBar.setRewinding(false)
}

// One rewind step: called every REWIND_STEP_BEATS beats of playback while
// armed (see onTick). Steps back one run and stops once run 1 (the
// beginning) is reached.
function stepRewind(): void {
  const pos = sessionBar.position()
  const next = Math.max(0, pos - 1)
  scrubSession(next)
  sessionBar.setPosition(next)
  if (next <= 0) stopRewind()
}

// The reset button was clicked: arm the rewind (starting playback if it isn't
// already running, so beats actually pass) or disarm it if already armed.
// Does nothing if there's nowhere to go back to.
function toggleRewind(): void {
  if (rewinding) {
    stopRewind()
    return
  }
  if (sessionBar.position() <= 0) return
  rewinding = true
  sessionBar.setRewinding(true)
  playback.play()
  // Baseline from wherever the playhead now sits (play() may have just reset
  // it) so the first step is REWIND_STEP_BEATS beats from arming, not from 0.
  rewindBaseline = lastTick
}

// Scrub to run `pos` — a non-destructive preview that restores *every* editable
// table to its state at that run (editableStore.setReplayView folds the shared
// log up to the run's index) and re-cooks the program that was live then (the
// "code" row at that run). It touches nothing in the head log and records no
// run, so pressing Run afterward forks forward from head as a new run rather
// than rewriting history. The newest position is the live head (replay view
// off), so any edits made since the last Apply stay visible there.
// Dragging the session scrubber fires cooks faster than the worker returns
// them; each result checks it is still the newest request before applying, so
// a stale run's tables never flash over the one the thumb is resting on.
let scrubEpoch = 0

async function scrubSession(pos: number): Promise<void> {
  // The scrub axis is the current branch path (apply nodes), or — for a legacy
  // session with no apply nodes — the flat run list, exactly as before. An empty
  // axis isn't necessarily "nothing to show": a Clear leaves the "code" table's
  // history (and head row) untouched, just with no bookmarks left to scrub to.
  // Treat it as "show head"; the codeRow check below still no-ops for a
  // genuinely empty session (no "code" table yet).
  const head = editableStore.currentHead()
  const path = head === null ? editableStore.runs() : editableStore.branchPath()
  const clamped = path.length ? Math.max(0, Math.min(pos, path.length - 1)) : 0
  const atLatest = path.length === 0 || clamped >= path.length - 1
  const epoch = ++scrubEpoch
  cooking++
  // Legacy runs replay by log-prefix (SessionRun); a branch path replays by
  // apply id (branch-aware — a mid-branch node shows only its committed history).
  const target = atLatest ? null : head === null ? (path[clamped] as SessionRun) : (path[clamped] as ApplyNode).id
  editableStore.setReplayView(target)
  // Keep the cook *and* the render inside one try: a program restored from a
  // saved session can fail either when it's cooked or when its cooked output is
  // applied, and both must surface on the editor's error strip rather than
  // vanishing as an unhandled rejection.
  try {
    const codeRow = editableStore.get('code')?.rows[0]
    if (!codeRow || typeof codeRow.code !== 'string') return
    const code = codeRow.code
    const seed = typeof codeRow.seed === 'number' ? codeRow.seed : 0
    const { cooked } = await cookInWorker(code, seed)
    if (epoch !== scrubEpoch) return
    liveCode = code
    liveSeed = seed
    editor.setCode(code)
    editor.setError(null)
    // Re-baseline the changed-detection at what's now showing, so the next Run's
    // apply pulse reports its diff against the scrubbed view the user sees.
    diffCooked(cooked)
    applyCooked(cooked)
  } catch (err) {
    if (epoch === scrubEpoch) editor.setError((err as Error).message)
  } finally {
    cooking--
  }
}

// Switching sessions while in a room would union the newly-loaded log into the
// room — leave the room first so sessions stay what they were.
function exitRoomMode(): void {
  if (!multiplayer) return
  multiplayer.close()
  multiplayer = null
  const u = new URL(location.href)
  u.searchParams.delete('room')
  u.searchParams.delete('user')
  history.replaceState(null, '', u)
  chipSolo()
}

async function openSession(id: string): Promise<void> {
  exitRoomMode()
  // Only a genuinely unreadable session aborts the switch: its stored data may
  // be missing, or editableStore.load may reject/throw on a corrupt log. A
  // session whose *program* errors is not corrupt — it still opens (below).
  try {
    const events = await sessionStore.load(id)
    if (events == null) throw new Error('saved session data is missing')
    const ok = quietly(() => editableStore.load(events))
    if (!ok) throw new Error('saved session data could not be read')
  } catch (err) {
    editor.setError(`Could not open session: ${(err as Error).message}`)
    return
  }
  currentSessionId = id
  // A branching session's scrub axis is its branch path (load() already adopted
  // the newest apply as head), so its legacy run list is unused — restore/derive
  // runs only for a session with no apply nodes (a legacy linear session, or one
  // Cleared to none; deriveRunsFromCode stops at the clear marker either way).
  const savedRuns = await sessionStore.runs(id).catch(() => [])
  quietly(() => {
    if (editableStore.currentHead() !== null) return
    if (savedRuns.length) editableStore.setRuns(savedRuns)
    else editableStore.deriveRunsFromCode()
  })
  sessionBar.setLog({ length: sessionLength() })
  refreshSelector()

  // Open the session for editing *before* running it: show its program and make
  // its tables editable now, so that if the program errors when cooked below the
  // session still ends up genuinely open — the editor holds its code and the
  // table panel its editable tables — exactly as if the user had been sitting on
  // this session and pressed Run to a failure. Editability reads the store
  // directly (see table-panel), so an empty view map is enough; a successful
  // cook replaces it via applyCooked, a failed one leaves just these tables.
  const codeRow = editableStore.get('code')?.rows[0]
  if (codeRow && typeof codeRow.code === 'string') editor.setCode(codeRow.code)
  lastViews = new Map<string, Table>()
  updateSliderDefs(lastViews)
  tablePanel.setTables(tablesForDisplay(lastViews))

  // The run (cook + render) of the restored program surfaces its own errors on
  // the editor's error strip without disturbing the opened tables above.
  scrubSession(Math.max(0, sessionLength() - 1))
}

function newSession(): void {
  exitRoomMode()
  currentSessionId = sessionStore.newId()
  quietly(() => editableStore.clear())
  editor.setCode(defaultProgram)
  evaluate(defaultProgram, { setError: editor.setError, persist: false, seeds: defaultTables })
  sessionBar.setLog({ length: sessionLength() })
  refreshSelector()
}

// The "Clear" button: wipe the run list a session bar scrubs over, without
// touching a single table's own event history — the program text, every
// editable table's rows, all of it stay exactly as they are. Records a
// CLEAR_RUNS_KIND marker (on the "activity" table, alongside 'apply' and
// 'session-start') rather than deleting anything, so deriveRunsFromCode()
// knows not to resurrect these runs on a later reload/session-switch (see
// its doc comment in editable-tables.ts).
function clearRuns(): void {
  stopRewind()
  quietly(() => {
    editableStore.record(ACTIVITY_TABLE, CLEAR_RUNS_KIND)
    editableStore.setRuns([])
  })
  sessionBar.setLog({ length: sessionLength() })
  persistSession()
}

const sessionBar = createSessionBar({
  onScrub: (pos) => { stopRewind(); scrubSession(pos) },
  onReset: toggleRewind,
})
function openExample(index: number): void {
  const sample = SAMPLES[index]
  if (!sample) return
  exitRoomMode()
  currentSessionId = sessionStore.newId()
  quietly(() => editableStore.clear())
  editor.setCode(sample.code)
  // The sample's editable table data (if any) seeds the freshly-cleared store,
  // so the example's editable(name, schema) calls carry column schemas only —
  // the row data lives with the sample, and populates the table panel on open.
  void evaluate(sample.code, { setError: editor.setError, persist: false, seeds: sample.tables })
  sessionBar.setLog({ length: sessionLength() })
  refreshSelector()
}

const sessionSelector = createSessionSelector({
  onOpen: (id) => void openSession(id),
  onNew: newSession,
  onExample: openExample,
  examples: SAMPLES.map((s) => ({ label: s.name })),
  // Naming and archiving act on the stored record only — the open session's
  // log is untouched, so neither needs a re-cook, just a re-listed dropdown.
  onRename: (id, name) => void sessionStore.rename(id, name).then(refreshSelector).catch(() => {}),
  onArchive: (id, archived) => void sessionStore.setArchived(id, archived).then(refreshSelector).catch(() => {}),
})

// The room chip: solo it opens a join popover (room name + username, seeding
// the room with the current session and reloading into it); in a room it
// shows status/peers and leaves on click.
const roomChip = createRoomChip({
  initialUser: getUsername(),
  onJoin: (name, user) => {
    setUsername(user)
    const u = new URL(location.href)
    u.searchParams.set('room', name)
    if (user) u.searchParams.set('user', user)
    else u.searchParams.delete('user')
    const go = (): void => { location.href = u.toString() }
    // Seed the room with what's on screen: park the store under the room's
    // session id so the reload (and then the server) picks it up. Navigation
    // waits for the save (it's async now) — and proceeds even if it fails,
    // since the room join itself will still sync whatever peers hold.
    if (editableStore.has('code')) {
      void sessionStore.save(roomSessionId(name), {
        events: editableStore.serialize(),
        runs: editableStore.runs(),
        tables: [...lastViews.keys()],
      }).then(go, go)
    } else {
      go()
    }
  },
  onLeave: () => {
    const u = new URL(location.href)
    u.searchParams.delete('room')
    u.searchParams.delete('user')
    location.href = u.toString()
  },
})

// Mount the whole layout in one Solid render — every pane except the canvas
// *contents* is created there from the controllers above (see ui/app.tsx).
// The render hands back the canvas elements; three.js renders the 3D scene
// into three-canvas, and hydra takes that as a source texture and
// post-processes it onto the visible hydra-canvas. The playback engine rides
// on those APIs, so it's built last and pushed into the signal the app
// render is watching.
const mounts = mountApp(document.getElementById('app') as HTMLElement, {
  editor,
  tablePanel,
  sessionBar,
  sessionSelector,
  roomChip,
  sliderPanel,
  playback: playbackCtl,
  onClearRuns: clearRuns,
})
const sceneAPI = initThree(mounts.threeCanvas, mounts.canvasPane)
const hydraAPI = initHydra(mounts.hydraCanvas, mounts.threeCanvas)
const playbackController = createPlaybackController(
  [createSceneVisualizer(sceneAPI), createHydraVisualizer(hydraAPI)],
  playbackOptions,
)
setPlaybackCtl(playbackController)
playback = playbackController.engine

function chipSolo(): void {
  roomChip.set({ kind: 'solo' })
}

// Redraws the chip for `status` at the *current* peer fold (re-folded from
// the "activity" table and the presence log each time, not pushed) — called
// on a connection status change and again whenever a peer-join/leave lands.
// Takes status as a plain argument rather than reading `multiplayer` because
// connectMultiplayer's onStatus can fire synchronously during its own call,
// before the `multiplayer = connectMultiplayer(...)` assignment below has
// completed.
function chipStatus(status: MultiplayerStatus): void {
  if (status === 'closed' || !roomName) return
  const online = onlinePeers()
  const me = localSource()
  const peerNames = presence
    ? [...presence.peers().values()]
        .filter((p) => p.client !== me && online.has(p.client))
        .map((p) => peerLabel(p.client, p.user))
    : []
  roomChip.set({ kind: 'room', status, room: roomName, user: userName, peerNames })
}

async function bootRoom(room: string): Promise<void> {
  // A room's log is also persisted locally under its stable session id, so
  // rejoining resumes the jam even before the server answers — restore that
  // copy first, then connect (the join snapshot carries it up).
  try {
    const saved = await sessionStore.load(currentSessionId)
    if (saved) {
      quietly(() => editableStore.load(saved))
      const savedRuns = await sessionStore.runs(currentSessionId).catch(() => [])
      quietly(() => {
        if (editableStore.currentHead() !== null) return
        if (savedRuns.length) editableStore.setRuns(savedRuns)
        else editableStore.deriveRunsFromCode()
      })
    }
  } catch { /* no local copy — the join sync seeds us from peers instead */ }

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
    if (presenceChanged) {
      chipStatus(multiplayer?.status ?? 'connecting')
      // A departed peer's indicators come down; a joiner's may already be
      // waiting in the synced presence log.
      schedulePresenceRefresh()
    }
  })
  // A collaborator's tap arrived: refresh the "taps" table and retime the
  // tempo, same as a local tap (see onTap).
  tapLog.log.onMerge(() => onTap())
  // Announce ourselves before joining (the join snapshot carries it): which
  // cell the editor starts on, plus our username riding along.
  presence?.set({ cell: localCell })
  chipStatus('connecting')
  multiplayer = connectMultiplayer({
    url: multiplayerUrl(),
    room,
    logs: { session: editableStore.log, taps: tapLog.log, [PRESENCE_LOG]: presence!.log },
    onStatus: chipStatus,
  })
}

function firstRun(): void {
  if (sessionLength()) {
    // Rejoined a room whose store we already had locally: resume it, don't
    // append a new run.
    scrubSession(sessionLength() - 1)
  } else {
    // Speculative: nothing here yet, show the default program. If a room
    // snapshot merges in while this first cook boots the worker, yield to it
    // (see obsoleteIfProgramChanged) instead of clobbering the room.
    evaluate(editor.getCode(), { setError: editor.setError, persist: false, obsoleteIfProgramChanged: true, seeds: defaultTables })
  }
  sessionBar.setLog({ length: sessionLength() })
  refreshSelector()
}

// Physics (jolt's WASM) now loads inside the cook worker, which holds the
// first cook until it settles — nothing to wait for here. A room boot first
// awaits the locally-persisted copy of the room's log (bootRoom), so
// firstRun's "resume or speculative default" decision sees the restored runs.
async function boot(): Promise<void> {
  if (roomName) await bootRoom(roomName)
  else chipSolo()
  firstRun()
}

void boot()
