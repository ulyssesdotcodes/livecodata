// Event-sourced user tables: what's stored is never a table but an
// append-only log of change events; the visible table is a fold of them.
// Every table — including the program itself, stored as a table named
// "code" — rides ONE shared log, and that log is the unit a session
// persists and multiplayer syncs.

import { compareEvents, createEventLog, type EventLog, type EventMigration, type StampedEvent } from './event-log.js'
import { buildBranchTree, branchEvents, APPLY_KIND, type ApplyNode, type BranchTree } from './branches.js'
import type { Row } from './lineage.js'

// The pseudo-table Apply pulses, peer-join/leave and session markers ride.
export const ACTIVITY_TABLE = 'activity'

// Suffix of a table's read-only edit-history view (`foo·events`) — the name
// its log wears in the panel and the table() name a program reads it under.
// Lives here (table-panel.ts re-exports it) so the cook worker can name
// histories without pulling in panel code.
export const EVENTS_SUFFIX = '·events'

// 'a' prefix keeps apply ids distinguishable from replica ids in log dumps.
function mintApplyId(): string {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// (src, seq) event key — mirrors event-log.ts's private eventKey.
const eventKey = (e: StampedEvent): string => `${e.src ?? ''}#${e.seq}`

export type ColumnType = 'number' | 'string' | 'boolean' | 'code' | 'enum'

// Language of a 'code' column's cells. 'dsl'/'hydra'/'post' are JS and get
// language service support (each with its own ambient surface); 'bauble' is
// Janet, so the editor opens those cells with the service off (see
// editor-support.ts) rather than offering JS completions on lisp.
export type CodeLanguage = 'dsl' | 'hydra' | 'bauble' | 'post'

// A column spec as passed to editable(name, schema). A string array is
// shorthand for an enum over those values; enum columns are code-only — the
// "+ column" UI never creates one.
export type ColumnSpec =
  | ColumnType
  | readonly string[]
  | { type: ColumnType; options?: readonly string[]; language?: CodeLanguage }
export type Schema = Record<string, ColumnSpec>

/**
 * The session bookmark recorded on Apply. `at` is the log length then —
 * refolding that prefix reconstructs every table's state. `tables` (per-table
 * event counts) is kept for display/serialization; replay uses `at`, which
 * stays correct across renames/removes.
 */
export interface SessionRun {
  at: number
  tables: Record<string, number>
}

// "Clear" marker on the activity table — a marker, not a deletion: history is
// untouched, but deriveRunsFromCode() won't resurrect runs from before it.
export const CLEAR_RUNS_KIND = 'clear-runs'

export interface EditableColumn {
  name: string
  type: ColumnType
  options?: string[] // 'enum' columns: the allowed values
  language?: CodeLanguage // 'code' columns; absent means the DSL
}

export interface EditableTableData {
  columns: EditableColumn[]
  rows: Row[]
  events: Row[] // edit history, as display rows for the read-only `name·events` table
}

// Line-mute switch: a row with `disabled` checked is hidden from the program
// (ensure()'s return) but stays in the table for re-enabling. Deliberately an
// ordinary column, not provenance, so it rides every existing mechanism for free.
export const DISABLED_COL = 'disabled'

function visibleRows(t: TableState): Row[] {
  return t.rows.filter((r) => r[DISABLED_COL] !== true)
}

function defaultFor(type: ColumnType, options?: string[]): unknown {
  switch (type) {
    case 'number': return 0
    case 'boolean': return false
    case 'enum': return options?.[0] ?? ''
    default: return ''
  }
}

/**
 * Blank/unset cells always pass: event tables are deliberately sparse, so only
 * a non-blank wrong-typed value (or an enum value outside its options) is
 * worth flagging.
 */
export function cellValid(value: unknown, col: EditableColumn): boolean {
  if (value === '' || value == null) return true
  switch (col.type) {
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'enum': return typeof value === 'string' && !!col.options?.includes(value)
    default: return true
  }
}

export function invalidColumns(row: Row, columns: EditableColumn[]): string[] {
  return columns.filter((c) => !cellValid(row[c.name], c)).map((c) => c.name)
}

// Per-row provenance, parallel to `rows`. code: originated from a program seed;
// dirty: user-edited or user-added, so a re-seed must NOT overwrite it; slot:
// index in the seed list — the identity a re-seed aligns to (-1 for user rows).
interface RowMeta {
  code: boolean
  dirty: boolean
  slot: number
}

const userMeta = (): RowMeta => ({ code: false, dirty: true, slot: -1 })
const seedMeta = (slot: number): RowMeta => ({ code: true, dirty: false, slot })

// One table's folded state. Columns aren't stored as one list — see
// effectiveColumns() — so a column's provenance (program-declared vs.
// user-touched) survives the fold.
interface TableState {
  // Columns from genuine table-panel actions (touching a declared column
  // "claims" it). Never mutated by a program's editable() call.
  userColumns: EditableColumn[]
  // Removed via the table panel — excluded even if still declared, so a
  // removal sticks across the program's next Apply.
  removedColumns: Set<string>
  // Most recently declared schema; null when no program ever declared one.
  declared: EditableColumn[] | null
  rows: Row[]
  rowMeta: RowMeta[]
  events: Row[]
  // Created by a program editable() declaration. Only such tables get
  // re-seeded and pruned by retainDeclared — a user's "+ table" never is.
  codeCreated: boolean
  // The last seed verbatim — the diff baseline so an unchanged seed appends
  // nothing (like an unchanged schema). null until a program has seeded.
  lastSeed: Row[] | null
  // Seed slots whose code row the user deleted — tombstoned so a re-seed
  // doesn't bring the row back.
  removedSlots: Set<number>
  // A pure record() event stream — no rows/columns of its own; the table
  // panel shows it read-only instead of offering row/column editing.
  log: boolean
}

// Declared supplies the columns and their order, but a userColumns entry for
// the same name wins (an explicit user edit beats what the program says);
// user-only columns are appended after.
function mergeColumns(userColumns: EditableColumn[], declared: EditableColumn[]): EditableColumn[] {
  const userByName = new Map(userColumns.map((c) => [c.name, c]))
  const declaredNames = new Set(declared.map((c) => c.name))
  const merged = declared.map((c) => userByName.get(c.name) ?? c)
  for (const c of userColumns) if (!declaredNames.has(c.name)) merged.push(c)
  return merged
}

// The one place a table's current columns are computed — there is no stored
// `columns` field anywhere else.
function effectiveColumns(t: TableState): EditableColumn[] {
  const cols = t.declared ? mergeColumns(t.userColumns, t.declared) : t.userColumns
  return t.removedColumns.size ? cols.filter((c) => !t.removedColumns.has(c.name)) : cols
}

// Display form of an event: the table name is implicit in which events-table
// it appears in, so it's dropped.
function eventRow(e: StampedEvent): Row {
  const { table: _table, ...rest } = e
  return rest
}

/**
 * Rebuild a row to match `columns`, keeping matching data, defaulting the
 * rest. Exported for the cook worker (see cook-service.ts).
 */
export function conformRow(row: Row, columns: EditableColumn[]): Row {
  const next: Row = {}
  for (const c of columns) next[c.name] = c.name in row ? row[c.name] : defaultFor(c.type, c.options)
  return next
}

// A create/declare-schema event's `columns`, tolerant of legacy shapes (older
// sessions stored the raw schema object, not the column array). Anything else
// reads as no columns, so a session's table data always loads.
function eventColumns(raw: unknown): EditableColumn[] {
  if (Array.isArray(raw)) return raw.map((c) => ({ ...(c as EditableColumn) }))
  if (raw && typeof raw === 'object') return schemaColumns(raw as Schema)
  return []
}

// A malformed or legacy `rows` field must never throw the fold that loads
// the rest of the session.
function eventRows(raw: unknown): Row[] {
  return Array.isArray(raw) ? (raw as Row[]) : []
}

/** Normalize an editable() schema into the column-list form events carry. */
export function schemaColumns(schema: Schema): EditableColumn[] {
  return Object.entries(schema).map(([name, spec]) => {
    if (Array.isArray(spec)) return { name, type: 'enum', options: [...spec] }
    if (typeof spec === 'object') {
      const s = spec as { type: ColumnType; options?: readonly string[]; language?: CodeLanguage }
      return {
        name,
        type: s.type,
        ...(s.options ? { options: [...s.options] } : {}),
        ...(s.language && s.type === 'code' ? { language: s.language } : {}),
      }
    }
    return { name, type: spec as ColumnType }
  })
}

// ── Serialized-schema migrations ─────────────────────────────────────────────
// Append here — never edit or reorder — when the persisted event shape changes
// (see EventMigration); the fold only ever sees current-shape events.

// v1 → v2: create/declare-schema `columns` used to be the raw schema object
// ({ name: type }); normalize to the column array the fold reads.
function migrateColumnsToArray(events: StampedEvent[]): StampedEvent[] {
  return events.map((e) => {
    if (e.kind !== 'create' && e.kind !== 'declare-schema') return e
    const cols = e.columns
    if (!cols || Array.isArray(cols) || typeof cols !== 'object') return e
    return { ...e, columns: schemaColumns(cols as Schema) }
  })
}

const EDITABLE_MIGRATIONS: EventMigration[] = [migrateColumnsToArray]

// Re-drive a code-created table's rows from a fresh seed: a pristine code row
// (code && !dirty) takes the new seed value at its slot; a dirty row stays as-is.
// Alignment is by slot, not position, so user-added rows interleaved among the
// seed don't drag values out of step, and a deleted slot stays deleted.
function reseedRows(t: TableState, seed: Row[]): void {
  const cols = effectiveColumns(t)
  const nextRows: Row[] = []
  const nextMeta: RowMeta[] = []
  const consumed = new Set<number>()
  for (let i = 0; i < t.rows.length; i++) {
    const meta = t.rowMeta[i]
    if (!meta.code) {
      nextRows.push(t.rows[i])
      nextMeta.push(meta)
      continue
    }
    consumed.add(meta.slot)
    if (meta.dirty) {
      nextRows.push(t.rows[i])
      nextMeta.push(meta)
    } else if (meta.slot < seed.length) {
      nextRows.push(conformRow(seed[meta.slot], cols))
      nextMeta.push(seedMeta(meta.slot))
    }
    // else: a pristine code row whose slot the shrunk seed no longer covers — dropped.
  }
  // Append new (non-tombstoned) seed slots as fresh code rows.
  for (let slot = 0; slot < seed.length; slot++) {
    if (consumed.has(slot) || t.removedSlots.has(slot)) continue
    nextRows.push(conformRow(seed[slot], cols))
    nextMeta.push(seedMeta(slot))
  }
  t.rows = nextRows
  t.rowMeta = nextMeta
}

// Defensive (events may come from storage): unknown tables/columns/rows are
// ignored rather than thrown.
function applyEvent(tables: Map<string, TableState>, e: StampedEvent): void {
  const name = e.table as string
  if (e.kind === 'create') {
    if (tables.has(name)) return
    const columns = eventColumns(e.columns)
    // A DSL-originated create seeds `declared`; a table-panel create seeds
    // `userColumns` directly — no program declares it.
    const declared = e.declared === true ? columns : null
    const seed = eventRows(e.rows)
    const t: TableState = {
      userColumns: declared ? [] : columns, removedColumns: new Set(), declared,
      rows: [], rowMeta: [], events: [eventRow(e)], log: e.log === true,
      codeCreated: e.declared === true, lastSeed: e.declared === true ? seed.map((r) => ({ ...r })) : null,
      removedSlots: new Set(),
    }
    t.rows = seed.map((r) => conformRow(r, effectiveColumns(t)))
    t.rowMeta = seed.map((_r, i) => (t.codeCreated ? seedMeta(i) : userMeta()))
    tables.set(name, t)
    return
  }
  const t = tables.get(name)
  if (!t) return
  t.events.push(eventRow(e))
  switch (e.kind) {
    case 'declare-schema': {
      t.declared = eventColumns(e.columns)
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'seed-rows': {
      const seed = eventRows(e.rows)
      t.lastSeed = seed.map((r) => ({ ...r }))
      reseedRows(t, seed)
      break
    }
    case 'add-column': {
      const col = e.col as string
      if (!col || effectiveColumns(t).some((c) => c.name === col)) break
      t.userColumns.push({ name: col, type: e.type as ColumnType })
      t.removedColumns.delete(col)
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'remove-column': {
      const col = e.col as string
      t.userColumns = t.userColumns.filter((c) => c.name !== col)
      t.removedColumns.add(col)
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'rename-column': {
      const col = e.col as string, to = e.to as string
      const before = effectiveColumns(t)
      const existing = before.find((c) => c.name === col)
      if (!existing || !to || before.some((c) => c.name === to)) break
      const owned = t.userColumns.find((c) => c.name === col)
      if (owned) owned.name = to
      // Renaming a declared-only column "claims" it (whole column, so options/
      // language survive); the old declared name may reappear as a fresh column.
      else t.userColumns.push({ ...existing, name: to })
      t.rows.forEach((r) => { r[to] = r[col]; delete r[col] })
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'set-column-type': {
      const col = e.col as string, type = e.type as ColumnType
      const owned = t.userColumns.find((c) => c.name === col)
      if (owned) owned.type = type
      // Retyping a declared-only column "claims" it, same as a rename above.
      else if (effectiveColumns(t).some((c) => c.name === col)) t.userColumns.push({ name: col, type })
      break
    }
    case 'add-row': {
      const row: Row = {}
      for (const c of effectiveColumns(t)) row[c.name] = defaultFor(c.type, c.options)
      t.rows.push(row)
      t.rowMeta.push(userMeta())
      break
    }
    case 'remove-row': {
      const i = e.row as number
      if (i >= 0 && i < t.rows.length) {
        // Tombstone a code row's slot so a later re-seed doesn't resurrect it.
        const meta = t.rowMeta[i]
        if (meta.code) t.removedSlots.add(meta.slot)
        t.rows.splice(i, 1)
        t.rowMeta.splice(i, 1)
      }
      break
    }
    case 'duplicate-row': {
      const i = e.row as number
      const row = t.rows[i]
      // The copy takes user identity — a re-seed won't overwrite or drop it.
      if (row) { t.rows.splice(i + 1, 0, { ...row }); t.rowMeta.splice(i + 1, 0, userMeta()) }
      break
    }
    case 'set-cell': {
      const row = t.rows[e.row as number]
      if (row) { row[e.col as string] = e.value; t.rowMeta[e.row as number].dirty = true }
      break
    }
    case 'set-row': {
      const row = t.rows[e.row as number]
      if (row) { Object.assign(row, e.values as Record<string, unknown>); t.rowMeta[e.row as number].dirty = true }
      break
    }
    case 'rename-table': {
      const to = e.to as string
      if (!to || tables.has(to)) break
      tables.delete(name)
      tables.set(to, t)
      break
    }
    case 'remove-table':
      tables.delete(name)
      break
  }
}

function foldEventsMap(events: StampedEvent[]): Map<string, TableState> {
  const tables = new Map<string, TableState>()
  for (const e of events) {
    // One malformed event must never sink the whole load — skip it, fold the rest.
    try { applyEvent(tables, e) } catch { /* ignore an unfoldable event */ }
  }
  return tables
}

export interface EditableTableStore {
  readonly log: EventLog
  listNames(): string[]
  has(name: string): boolean
  // A record() event stream — the table panel skips row/column editing for it.
  isLog(name: string): boolean
  get(name: string): EditableTableData | undefined
  createTable(name: string): void
  removeTable(name: string): void
  renameTable(name: string, newName: string): boolean
  // The DSL's editable(name, schema): appends a create on first sight, a
  // declare-schema when the schema changed, and returns the folded rows.
  ensure(name: string, schema: Schema, seedRows?: Row[]): Row[]
  // Drop code-created tables not in `keep` — the program stopped declaring
  // them. User "+ table"s, record() streams and "code" are never touched.
  // Returns the removed names. No-op while replaying (reads must not mutate).
  retainDeclared(keep: Iterable<string>): string[]
  addColumn(name: string, colName: string, type: ColumnType): void
  removeColumn(name: string, colName: string): void
  setColumnType(name: string, colName: string, type: ColumnType): void
  renameColumn(name: string, colName: string, newName: string): boolean
  addRow(name: string): void
  removeRow(name: string, index: number): void
  duplicateRow(name: string, index: number): void
  setCell(name: string, index: number, colName: string, value: unknown): void
  // Several cells of one row as a single event — one history entry, never
  // observed half-updated (e.g. a Run sets `code` and `seed` together).
  setRow(name: string, index: number, values: Record<string, unknown>): void
  // Append an arbitrary event on `table` (auto-created columnless on first
  // sight) — for non-row streams like Apply pulses and peer join/leave. Riding
  // the same log gives them serialize/load/multiplayer-sync for free.
  record(table: string, kind: string, payload?: Record<string, unknown>): void
  onChange(cb: () => void): void
  // --- runs (session history) ---------------------------------------------
  // Record the Apply bookmark (see SessionRun) and return it.
  recordRun(): SessionRun
  runs(): SessionRun[]
  setRuns(runs: SessionRun[]): void
  // --- branches -----------------------------------------------------------
  // Commit pending edits as a new apply node — the branch-aware successor to
  // recordRun (the apply event *is* the run). `parent` fast-forwards to the
  // branch tip, unless forked (edit while scrubbed): then `parent` is the
  // scrubbed node and `seen` the abandoned tip, so it reads as a fork.
  recordApply(payload?: Record<string, unknown>): ApplyNode | null
  // Folded from the log's apply events (cached; invalidated by any change).
  branchTree(): BranchTree
  // The apply id the live fold shows; null for a fresh/legacy log.
  currentHead(): string | null
  // root..head applies on the current branch — the session bar's scrub axis
  // (applies at or before the latest clear-runs marker are hidden).
  branchPath(): ApplyNode[]
  // Switch the live fold to another branch head, dropping any un-applied tail.
  checkout(headId: string): void
  // Promote a scrubbed branch-node replay to a forked live head now. Fork-on-
  // edit runs anyway on first append, but a cook reads before it writes, so
  // evaluate forks up front. Returns whether a fork happened.
  forkFromReplay(): boolean
  // Backward compat for sessions that saved no run list: derive one run per
  // program Run in "code"'s history, stopping at the latest clear-runs marker.
  deriveRunsFromCode(): void
  // Show the store as it was at a past point: reads serve the historical fold
  // and ensure() appends nothing — a pure preview. `null` returns to the live
  // head. Target is an apply node id (mutating while there forks) or a legacy
  // SessionRun log prefix (mutating edits the head, as before branches).
  setReplayView(target: SessionRun | string | null): void
  // The event-data half of a persisted session (runs are the other half).
  // load() replaces the whole history, refolds, and resets runs.
  serialize(): string
  load(json: string | unknown): boolean
  clear(): void
}

export function createEditableTableStore({ src }: { src?: string } = {}): EditableTableStore {
  const log = createEventLog({ src, migrations: EDITABLE_MIGRATIONS })
  // The live head fold, kept incrementally by append(). Replay views are separate.
  let tables = new Map<string, TableState>()
  // Legacy linear scrub coordinates, kept for pre-branch sessions and
  // session-format round-trips. The branch tree is the live coordinate.
  let runs: SessionRun[] = []
  // When set (scrubbed replay), reads serve this fold and ensure() is read-only.
  let replay: Map<string, TableState> | null = null
  // Apply node id the replay shows; null for a legacy SessionRun replay (or none).
  let replayNode: string | null = null

  // --- branch state -----------------------------------------------------------
  // `head`: the apply whose branch the live fold shows (null = fresh/legacy).
  // `pending`: keys of un-applied events the next apply will claim. `forked`:
  // the live fold was promoted from a scrubbed replay, so the next apply
  // parents the scrubbed node; `seenTip` is the tip it forked away from.
  let head: string | null = null
  let pending: string[] = []
  let forked = false
  let seenTip: string | null = null
  let treeCache: BranchTree | null = null
  const branchTree = (): BranchTree => (treeCache ??= buildBranchTree(log.all()))
  const invalidateTree = (): void => { treeCache = null }

  const listeners: (() => void)[] = []
  const notify = (): void => listeners.forEach((cb) => cb())

  const view = (): Map<string, TableState> => replay ?? tables

  // Follow the linearized non-fork chain down from `id` to its branch tip —
  // where an ordinary apply fast-forwards its parent onto.
  function branchTip(id: string, tree: BranchTree): string {
    let cur = id
    for (;;) {
      const next = (tree.children.get(cur) ?? []).find((k) => !tree.nodes.get(k)!.fork)
      if (!next) return cur
      cur = next
    }
  }

  // Newest apply on any branch — the performance head peers follow, and the
  // parent for the first apply on a legacy/fresh log.
  function newestApplyId(tree: BranchTree): string | null {
    let best: ApplyNode | null = null
    for (const n of tree.nodes.values()) {
      if (!best || n.seq > best.seq || (n.seq === best.seq && n.src > best.src)) best = n
    }
    return best?.id ?? null
  }

  // Rebuild the live fold from `head`'s branch — for checkout and merge, where
  // the incremental fold can't absorb the change.
  function refoldBranch(): void {
    tables = foldEventsMap(branchEvents(log.all(), head, branchTree()))
  }

  // Working tail from the log alone: unclaimed non-apply events after the
  // newest apply. Reattaches `pending` after a reload mid-edit, since no
  // pending list is persisted.
  function deriveWorkingTail(tree: BranchTree): string[] {
    const all = log.all()
    const claimed = new Set<string>()
    for (const n of tree.nodes.values()) for (const k of n.edits) claimed.add(k)
    let newest: StampedEvent | null = null
    for (const e of all) {
      if (e.kind === APPLY_KIND && typeof e.id === 'string' && (!newest || compareEvents(e, newest) > 0)) newest = e
    }
    const out: string[] = []
    for (const e of all) {
      if (e.kind === APPLY_KIND) continue
      if (claimed.has(eventKey(e))) continue
      if (newest && compareEvents(e, newest) <= 0) continue
      out.push(eventKey(e))
    }
    return out
  }

  // Fork-on-edit: promote a scrubbed branch-node replay to the live fold and
  // discard the abandoned working tail — the old branch's applies still claim
  // their events, so nothing is rewritten.
  function forkFromReplay(): boolean {
    if (replay === null || replayNode === null || head === null) return false
    seenTip = branchTip(head, branchTree())
    head = replayNode
    forked = true
    pending = []
    tables = replay
    replay = null
    replayNode = null
    return true
  }

  function append(payload: Record<string, unknown> & { kind: string; table: string }): void {
    forkFromReplay()
    replay = null
    replayNode = null
    const e = log.append(payload)
    applyEvent(tables, e)
    // Every ordinary event (record() markers included) joins the working tail
    // so the next apply claims it; applies are never their own pending.
    if (e.kind !== APPLY_KIND) pending.push(eventKey(e))
    invalidateTree()
    notify()
  }

  // Remote events can land between existing ones, so refold rather than apply
  // incrementally. Any replay/fork-in-progress is dropped. When a peer's apply
  // merges in, follow it: the performance head is the newest apply on any
  // branch, so peers stay together.
  log.onMerge((added) => {
    replay = null
    replayNode = null
    forked = false
    invalidateTree()
    const tree = branchTree()
    if (added.some((e) => e.kind === APPLY_KIND && typeof e.id === 'string')) {
      const newest = newestApplyId(tree)
      if (newest) { head = newest; seenTip = newest }
    } else if (head !== null && !tree.nodes.has(head)) {
      head = newestApplyId(tree)
      seenTip = head
    }
    // Drop from pending anything a merged apply now claims (a peer committed
    // edits it had seen from us).
    if (pending.length) {
      const claimed = new Set<string>()
      for (const n of tree.nodes.values()) for (const k of n.edits) claimed.add(k)
      pending = pending.filter((k) => !claimed.has(k))
    }
    refoldBranch()
    notify()
  })

  return {
    log,
    listNames: () => [...view().keys()],
    has: (name) => view().has(name),
    isLog: (name) => view().get(name)?.log ?? false,

    get(name: string): EditableTableData | undefined {
      const t = view().get(name)
      return t ? { columns: effectiveColumns(t), rows: t.rows, events: t.events } : undefined
    },

    createTable(name: string): void {
      if (tables.has(name)) return
      // New tables start with "beat" — the 1-indexed beat convention tables key
      // time by; a beat past the loop's end lands in a later pass of the loop.
      append({ kind: 'create', table: name, columns: [{ name: 'beat', type: 'number' }] })
    },

    removeTable(name: string): void {
      if (!tables.has(name)) return
      append({ kind: 'remove-table', table: name })
    },

    renameTable(name: string, newName: string): boolean {
      newName = newName.trim()
      if (!newName || !tables.has(name) || tables.has(newName)) return false
      append({ kind: 'rename-table', table: name, to: newName })
      return true
    },

    ensure(name: string, schema: Schema, seedRows?: Row[]): Row[] {
      const wantCols = schemaColumns(schema)
      // Replay is a read-only preview: serve historical rows (or the seed, for
      // a table that didn't exist then) and append nothing.
      if (replay) {
        const t = replay.get(name)
        if (t) return visibleRows(t)
        return (seedRows ?? []).map((r) => conformRow(r, wantCols))
      }
      const existing = tables.get(name)
      if (!existing) {
        append({ kind: 'create', table: name, columns: wantCols, rows: seedRows, declared: true })
        return visibleRows(tables.get(name)!)
      }
      if (JSON.stringify(existing.declared) !== JSON.stringify(wantCols)) {
        append({ kind: 'declare-schema', table: name, columns: wantCols })
      }
      // Unchanged seeds stay silent, like an unchanged schema, so an ordinary
      // Run of the same code appends nothing.
      const t = tables.get(name)!
      if (t.codeCreated && seedRows !== undefined && JSON.stringify(seedRows) !== JSON.stringify(t.lastSeed)) {
        append({ kind: 'seed-rows', table: name, rows: seedRows })
      }
      return visibleRows(tables.get(name)!)
    },

    retainDeclared(keep: Iterable<string>): string[] {
      if (replay) return []
      const keepSet = new Set(keep)
      const removed: string[] = []
      for (const [name, t] of tables) {
        // "code" is code-created too but is the program itself — never prune it.
        if (t.codeCreated && !t.log && name !== 'code' && !keepSet.has(name)) removed.push(name)
      }
      for (const name of removed) append({ kind: 'remove-table', table: name })
      return removed
    },

    addColumn(name: string, colName: string, type: ColumnType): void {
      colName = colName.trim()
      const t = tables.get(name)
      if (!t || !colName || effectiveColumns(t).some((c) => c.name === colName)) return
      append({ kind: 'add-column', table: name, col: colName, type })
    },

    removeColumn(name: string, colName: string): void {
      const t = tables.get(name)
      if (!t || !effectiveColumns(t).some((c) => c.name === colName)) return
      append({ kind: 'remove-column', table: name, col: colName })
    },

    setColumnType(name: string, colName: string, type: ColumnType): void {
      const t = tables.get(name)
      const col = t && effectiveColumns(t).find((c) => c.name === colName)
      if (!col || col.type === type) return
      append({ kind: 'set-column-type', table: name, col: colName, type })
    },

    renameColumn(name: string, colName: string, newName: string): boolean {
      newName = newName.trim()
      const t = tables.get(name)
      if (!t || !newName || newName === colName) return false
      const cols = effectiveColumns(t)
      if (!cols.some((c) => c.name === colName) || cols.some((c) => c.name === newName)) return false
      append({ kind: 'rename-column', table: name, col: colName, to: newName })
      return true
    },

    addRow(name: string): void {
      if (!tables.has(name)) return
      append({ kind: 'add-row', table: name })
    },

    removeRow(name: string, index: number): void {
      const t = tables.get(name)
      if (!t || index < 0 || index >= t.rows.length) return
      append({ kind: 'remove-row', table: name, row: index })
    },

    duplicateRow(name: string, index: number): void {
      const t = tables.get(name)
      if (!t || index < 0 || index >= t.rows.length) return
      append({ kind: 'duplicate-row', table: name, row: index })
    },

    setCell(name: string, index: number, colName: string, value: unknown): void {
      if (!tables.get(name)?.rows[index]) return
      append({ kind: 'set-cell', table: name, row: index, col: colName, value })
    },

    setRow(name: string, index: number, values: Record<string, unknown>): void {
      if (!tables.get(name)?.rows[index]) return
      append({ kind: 'set-row', table: name, row: index, values })
    },

    record(table: string, kind: string, payload: Record<string, unknown> = {}): void {
      if (!tables.has(table)) append({ kind: 'create', table, columns: [], log: true })
      append({ kind, table, ...payload })
    },

    onChange(cb: () => void): void {
      listeners.push(cb)
    },

    recordRun(): SessionRun {
      replay = null
      const tableIdx: Record<string, number> = {}
      for (const [name, t] of tables) tableIdx[name] = t.events.length
      const run: SessionRun = { at: log.length, tables: tableIdx }
      runs.push(run)
      return run
    },

    runs: () => runs.map((r) => ({ at: r.at, tables: { ...r.tables } })),

    setRuns(next: SessionRun[]): void {
      runs = next.map((r) => ({ at: r.at, tables: { ...r.tables } }))
    },

    deriveRunsFromCode(): void {
      const code = tables.get('code')
      const all = log.all()
      const clearedSeq = all.reduce((max, e) => (e.kind === CLEAR_RUNS_KIND ? Math.max(max, e.seq) : max), -1)
      runs = (code?.events ?? [])
        .filter((e) => (e.seq as number) > clearedSeq)
        .map((e) => {
          const at = (e.seq as number) + 1
          const tableIdx: Record<string, number> = {}
          for (const [name, t] of foldEventsMap(all.slice(0, at))) tableIdx[name] = t.events.length
          return { at, tables: tableIdx }
        })
    },

    recordApply(payload: Record<string, unknown> = {}): ApplyNode | null {
      replay = null
      replayNode = null
      const tree = branchTree()
      let parent: string | null
      let seen: string | null
      if (forked && head !== null) {
        // Deliberate fork: parent is the scrubbed node, seen the abandoned tip.
        parent = head
        seen = seenTip ?? head
      } else {
        // Ordinary apply: fast-forward onto the branch tip, so seen == parent.
        parent = head !== null ? branchTip(head, tree) : newestApplyId(tree)
        seen = parent
      }
      const id = mintApplyId()
      const edits = pending.slice()
      // Ensure the activity table exists first — the fold drops events on an
      // unknown table.
      if (!tables.has(ACTIVITY_TABLE)) {
        const create = log.append({ kind: 'create', table: ACTIVITY_TABLE, columns: [], log: true })
        applyEvent(tables, create)
        edits.push(eventKey(create))
      }
      const e = log.append({ kind: APPLY_KIND, table: ACTIVITY_TABLE, id, parent, seen, edits, ...payload })
      applyEvent(tables, e)
      head = id
      seenTip = id
      forked = false
      pending = []
      invalidateTree()
      notify()
      return branchTree().nodes.get(id) ?? null
    },

    branchTree,

    currentHead: () => head,

    branchPath(): ApplyNode[] {
      if (head === null) return []
      const all = log.all()
      const clearedSeq = all.reduce((max, e) => (e.kind === CLEAR_RUNS_KIND ? Math.max(max, e.seq) : max), -1)
      // Hide applies at or before the latest clear marker — the fold still
      // uses the full path.
      return branchTree().pathTo(head).filter((n) => n.seq > clearedSeq)
    },

    checkout(headId: string): void {
      if (!branchTree().nodes.has(headId)) return
      replay = null
      replayNode = null
      forked = false
      head = headId
      seenTip = headId
      pending = []
      refoldBranch()
      notify()
    },

    forkFromReplay(): boolean {
      const forkedNow = forkFromReplay()
      if (forkedNow) { invalidateTree(); notify() }
      return forkedNow
    },

    setReplayView(target: SessionRun | string | null): void {
      if (target === null) {
        replay = null
        replayNode = null
      } else if (typeof target === 'string') {
        // Branch-aware scrub: fold that apply's branch up to it.
        replayNode = target
        replay = foldEventsMap(branchEvents(log.all(), target, branchTree()))
      } else {
        // Legacy SessionRun: a log prefix.
        replayNode = null
        replay = foldEventsMap(log.all().slice(0, target.at))
      }
    },

    serialize: () => log.serialize(),

    load(json: string | unknown): boolean {
      if (!log.load(json)) return false
      replay = null
      replayNode = null
      runs = []
      forked = false
      pending = []
      invalidateTree()
      // Adopt the newest apply so a saved branching session opens on its latest
      // branch; a legacy log has none, so head stays null (linear).
      head = newestApplyId(branchTree())
      seenTip = head
      // Reattach any un-applied working tail so the next apply claims it.
      pending = head !== null ? deriveWorkingTail(branchTree()) : []
      refoldBranch()
      notify()
      return true
    },

    clear(): void {
      log.clear()
      tables = new Map()
      replay = null
      replayNode = null
      runs = []
      head = null
      seenTip = null
      forked = false
      pending = []
      invalidateTree()
      notify()
    },
  }
}
