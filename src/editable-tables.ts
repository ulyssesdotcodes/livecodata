// livecodata editable tables — event-sourced
// ----------------------------------------------------------------------------
// User-authored tables, as opposed to the code-generated views produced by
// running the DSL program. What is *stored* is never the table itself but the
// append-only log of change events — add-row, set-cell, rename-column, … —
// on the shared event-log primitive. The visible table is a fold of those
// events up to now, so every editable table is really two tables: the
// interactive current state (`name`) and the read-only edit history
// (`name·events`). Editing a cell doesn't overwrite anything; it appends.
//
// The whole store — every table — rides ONE event log, so its serialize/load
// round-trips the entire store in one shot: that's the unit a session
// persists (see sessions.ts/main.ts) and also the unit multiplayer syncs (see
// multiplayer.ts) — merging in another replica's events refolds every table
// (including "code") from the union. The store itself holds no storage
// reference of its own; the caller owns if/when/where it's saved.
//
// The main program is not exempt from this: it lives here too, as an
// editable table named "code" (columns `code`/`seed`, always exactly one
// row) that main.ts writes on every Run. Clicking Apply/Ctrl-Enter records a
// "run" (see recordRun/SessionRun) — a bookmark of every table's log index at
// that moment, spanning the whole store rather than just "code" — and the
// session bar scrubs those runs, folding the log back to any of them
// (setReplayView) to reproduce the exact state then. So "the session" is this
// store's events *plus* its list of runs (persisted together — see sessions.ts).
//
// A program reads a table via the DSL's editable(name, schema) — see dsl.ts —
// which appends a create (or declare-schema) event on first sight and returns
// the folded rows. That's the "specify types in the code editor" path; the
// table panel's own +table / +column UI is the other way to create/shape one.
// Column type "code" marks cells edited in the main code editor (click the
// cell) rather than inline.
//
// Rows have provenance too (see RowMeta). editable(name, schema, seedRows)
// seeds a table's rows from code on first sight; on a later Run with a *changed*
// seed, the rows the user hasn't touched are re-driven to the new seed values
// (a `seed-rows` event → reseedRows), while any row the user edited or added
// stays put — the edit log is what tells the two apart. And a table the program
// created but has *stopped* declaring is pruned (retainDeclared): it stops being
// editable, yielding to a computed view of the same name, or vanishing. A user's
// own "+ table" is exempt from both — the program never owned it.
//
// A table's *effective* columns are computed, not stored as one blob: each
// table tracks `userColumns` (a fold over genuine table-panel actions —
// add/remove/rename/retype a column, or the seed of a table-panel-created
// table) separately from `declared` (the most recent schema a program passed
// to editable(name, schema)). effectiveColumns() merges the two on every read
// — declared supplies columns and their order, userColumns overrides a
// declared column's type once the user has explicitly touched it (and
// contributes any extra columns declared doesn't mention) — so a column the
// user genuinely added/edited survives regardless of what the program
// declares on a later Apply, while a column that only ever existed because
// the program declared it comes and goes freely as the declaration changes.
// ----------------------------------------------------------------------------

import { compareEvents, createEventLog, type EventLog, type EventMigration, type StampedEvent } from './event-log.js'
import { buildBranchTree, branchEvents, APPLY_KIND, type ApplyNode, type BranchTree } from './branches.js'
import type { Row } from './lineage.js'

// The "activity" pseudo-table every Apply pulse, peer-join/leave and session
// marker rides (see EditableTableStore.record / main.ts). Exported so the apply
// node the branch tree folds (recordApply) and its consumers agree on the name.
export const ACTIVITY_TABLE = 'activity'

// A stable, unique id for an apply node — the thing `parent`/`seen` reference.
// Same recipe as localSource()'s replica id, but its own 'a' prefix so an apply
// id never reads like a replica id in a log dump.
function mintApplyId(): string {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// An edit event's identity in the log — the (src, seq) key an apply's `edits`
// list holds (mirrors event-log.ts's private eventKey).
const eventKey = (e: StampedEvent): string => `${e.src ?? ''}#${e.seq}`

export type ColumnType = 'number' | 'string' | 'boolean' | 'code' | 'enum'

// What language a 'code' column's cells are written in — it decides which
// surface the main editor's completions/hover/signature help run against when
// a cell opens there. Kept in sync with lang-service.ts's EditorLang (the
// same union, named from the editor's side); add new languages to both.
export type CodeLanguage = 'dsl' | 'hydra'

// A column's spec as a program passes it to editable(name, schema). A bare
// ColumnType is the common case; a string array is shorthand for an enum over
// those values; the object form spells an enum out (or any type) explicitly —
// and is how a code column declares its language, e.g.
// { type: "code", language: "hydra" } (default "dsl"). Enum columns are
// code-only — the table panel renders them as a dropdown (and validates
// against their options), but the "+ column" UI never creates one.
export type ColumnSpec =
  | ColumnType
  | readonly string[]
  | { type: ColumnType; options?: readonly string[]; language?: CodeLanguage }
export type Schema = Record<string, ColumnSpec>

// A "run": the session bookmark recorded when the user clicks Apply (Ctrl-Enter)
// after a batch of edits. It captures, per editable table, how many of that
// table's log events had landed at that moment (its name·events length) — the
// "index per editable table event log" the session scrubs over. Because the
// whole store rides ONE ordered log, that snapshot is exactly a prefix of the
// log: `at` is its length, and re-folding the log up to `at` reconstructs every
// table's state as it was at that run. `tables` is the same cut expressed the
// way the user thinks of it (one index per table) — kept for display and so the
// serialized session literally is "the event data + a list of per-table
// indices", but replay uses `at`, which stays correct across renames/removes.
export interface SessionRun {
  at: number
  tables: Record<string, number>
}

// The event kind a "Clear" click records (see main.ts's clearRuns, ridden on
// the "activity" pseudo-table like 'apply'/'session-start') to wipe the run
// list. It's a marker, not a deletion: every table's own history — "code"'s
// included — is untouched, so deriveRunsFromCode() (the legacy/no-saved-runs
// fallback) knows to derive nothing from before it rather than resurrecting
// runs the user just cleared.
export const CLEAR_RUNS_KIND = 'clear-runs'

export interface EditableColumn {
  name: string
  type: ColumnType
  // For an 'enum' column: the allowed values — the dropdown's choices, and the
  // set a validator checks a cell against. Absent for every other type.
  options?: string[]
  // For a 'code' column: the language its cells hold (see CodeLanguage).
  // Absent means the DSL.
  language?: CodeLanguage
}

export interface EditableTableData {
  columns: EditableColumn[]
  rows: Row[]
  // The edit history, as display rows for the read-only `name·events` table.
  events: Row[]
}

// A row's own boolean `disabled` field — an ordinary column, not separate
// provenance — is the line-mute switch: check it via "+ column" (boolean
// type) and it disappears from what the program sees (ensure()'s return)
// while staying in the table, still shown and editable, for switching back.
// No dedicated event/meta plumbing: it's just data, so it rides every
// existing mechanism (conform on schema change, survive a re-seed as any
// other untouched cell would, round-trip through serialize/load) for free.
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

// Whether a cell's value fits its column's declared type — the check the table
// panel uses to flag rows that don't match an editable() schema. Blank/unset
// cells are always allowed: these event tables are deliberately sparse (a
// setCode row leaves the enum/number columns of other events empty), so only a
// *non-blank* value of the wrong type — or an enum value outside its options —
// is a genuine mistake worth highlighting.
export function cellValid(value: unknown, col: EditableColumn): boolean {
  if (value === '' || value == null) return true
  switch (col.type) {
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'enum': return typeof value === 'string' && !!col.options?.includes(value)
    default: return true // string / code accept any non-blank value
  }
}

// The names of the columns whose cell in `row` doesn't fit its type — empty
// when the row conforms. The table panel highlights these cells (and marks the
// row) so a mistyped value or a misspelled enum stands out at a glance.
export function invalidColumns(row: Row, columns: EditableColumn[]): string[] {
  return columns.filter((c) => !cellValid(row[c.name], c)).map((c) => c.name)
}

// Per-row provenance, kept parallel to `rows`. It's what lets a code-seeded
// row be re-driven by the program (bug: "rows created by code should be
// replaced by code when the code is re-run if they are unchanged") while a row
// the user has touched stays put:
//   code  — the row originated from a program seed (editable(…, seedRows)), not
//           a table-panel "+ row"/duplicate.
//   dirty — the user has since edited this row (a set-cell/set-row landed on
//           it) or it's a user-added row: either way the program must NOT
//           overwrite it on a re-seed.
//   slot  — for a code row, its index in the seed list it came from, the stable
//           identity a re-seed aligns new seed values to (and that a remove
//           tombstones, so a deleted code row isn't resurrected by a later
//           seed). -1 for user rows.
interface RowMeta {
  code: boolean
  dirty: boolean
  slot: number
}

const userMeta = (): RowMeta => ({ code: false, dirty: true, slot: -1 })
const seedMeta = (slot: number): RowMeta => ({ code: true, dirty: false, slot })

// One table's folded state. `events` accumulates the display form of every
// event that touched this table (riding along through renames). `columns`
// isn't stored directly — see effectiveColumns() below — so that a column's
// provenance (declared by the program vs. added/edited by the user) survives
// the fold instead of collapsing into one opaque list.
interface TableState {
  // Columns from genuine table-panel actions: add-column, a rename/retype
  // (even of a column that started out declared — touching it via the table
  // panel "claims" it), or the seed columns of a table-panel-created table.
  // Never mutated by a program's editable(name, schema) call.
  userColumns: EditableColumn[]
  // Column names explicitly removed via the table panel — excluded from the
  // effective columns even if `declared` still asks for them, so a removal
  // sticks instead of reappearing on the program's next Apply.
  removedColumns: Set<string>
  // The most recently declared schema (editable(name, schema)), or null for
  // a table the program never declared (purely table-panel driven, e.g. "+
  // table"). Replaced wholesale by each declare-schema event.
  declared: EditableColumn[] | null
  rows: Row[]
  // Parallel to `rows` (same length, same order): each row's provenance.
  rowMeta: RowMeta[]
  events: Row[]
  // True once the table was first brought into being by a program editable()
  // declaration (a `declared` create), as opposed to a table-panel "+ table"
  // or a record() log stream. Drives two program-owned behaviours: re-seeding
  // (only a code-created table's rows are re-driven by later seeds) and
  // retainDeclared (only code-created tables are pruned when the program stops
  // declaring them — a user's own "+ table" is never auto-removed).
  codeCreated: boolean
  // The seed rows the program last handed to editable(name, schema, seedRows),
  // verbatim — the baseline a later call diffs against to decide whether to
  // append a `seed-rows` event (so an unchanged seed is silent, like an
  // unchanged schema). null until a program has seeded the table.
  lastSeed: Row[] | null
  // Seed slots (see RowMeta.slot) whose code row the user deleted — tombstoned
  // so a later re-seed doesn't bring the row back.
  removedSlots: Set<number>
  // True for a pure event stream created via record() — an Apply pulse,
  // peer-join/leave, … (see EditableTableStore.record). Never has columns or
  // rows of its own, so it isn't a "row-editable table" at all; the table
  // panel shows it read-only, as its own event history, rather than offering
  // add/rename/retype-column or add/remove-row controls that would do nothing.
  log: boolean
}

// Merge a declared schema with the user's own columns: declared supplies the
// columns and their order, but a userColumns entry for the same name (the
// user explicitly retyped it via the table panel) overrides declared's type
// — an explicit user edit always wins over what the program currently says.
// Columns only in userColumns (the program never declared them) are appended
// after, in their own order.
function mergeColumns(userColumns: EditableColumn[], declared: EditableColumn[]): EditableColumn[] {
  const userByName = new Map(userColumns.map((c) => [c.name, c]))
  const declaredNames = new Set(declared.map((c) => c.name))
  const merged = declared.map((c) => userByName.get(c.name) ?? c)
  for (const c of userColumns) if (!declaredNames.has(c.name)) merged.push(c)
  return merged
}

// The columns a table actually shows: declared merged with userColumns (see
// mergeColumns), minus anything explicitly removed via the table panel. This
// is the one place "what are this table's columns right now" is computed —
// everywhere else works off it rather than reading a stored `columns` field.
function effectiveColumns(t: TableState): EditableColumn[] {
  const cols = t.declared ? mergeColumns(t.userColumns, t.declared) : t.userColumns
  return t.removedColumns.size ? cols.filter((c) => !t.removedColumns.has(c.name)) : cols
}

// The display form of an event: everything but the table name (implicit in
// which events-table it appears in), seq/t first.
function eventRow(e: StampedEvent): Row {
  const { table: _table, ...rest } = e
  return rest
}

// Rebuild a row to match `columns`, keeping matching data, defaulting the rest.
// Exported for the cook worker, which mirrors ensure()'s read-only replay
// semantics against a rows snapshot (see cook-service.ts).
export function conformRow(row: Row, columns: EditableColumn[]): Row {
  const next: Row = {}
  for (const c of columns) next[c.name] = c.name in row ? row[c.name] : defaultFor(c.type, c.options)
  return next
}

// A create/declare-schema event's `columns`, tolerant of how it was stored. The
// current format is an array of { name, type }; but a create event's schema is
// really a *specification* produced by running the program (see editable()), and
// older sessions serialized it as the raw editable() schema object
// ({ name: type }) instead of the column array. Accept either — array as-is, a
// schema object via schemaColumns — and treat anything else as no columns, so a
// session's actual table data always loads even when its saved schema is in a
// legacy or unexpected shape (the real columns get re-declared when the code
// next runs anyway).
function eventColumns(raw: unknown): EditableColumn[] {
  if (Array.isArray(raw)) return raw.map((c) => ({ ...(c as EditableColumn) }))
  if (raw && typeof raw === 'object') return schemaColumns(raw as Schema)
  return []
}

// A create/seed event's `rows`, guarded to an array — a malformed or legacy
// `rows` field must never throw the fold that loads the rest of the session.
function eventRows(raw: unknown): Row[] {
  return Array.isArray(raw) ? (raw as Row[]) : []
}

// An editable() schema in column-list form — the shape create/declare-schema
// events carry. Normalizes each ColumnSpec: a bare type stays a type, a string
// array becomes an enum column with those options, the object form is taken
// as-is (options and a code column's language copied when present).
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
// The chain that upgrades an on-disk event log to the current shape (see
// EventMigration). Append a migration here — never edit or reorder an existing
// one — whenever the persisted shape of an editable-table event changes, and
// old sessions keep loading. The fold (applyEvent) only ever sees current-shape
// events because load() runs these first.

// v1 → v2: a create/declare-schema event's `columns` used to be serialized as
// the raw editable() schema object ({ name: type }) — a specification produced
// by running the program — rather than the [{ name, type }] column array the
// fold reads. Normalize any object-shaped `columns` into the array form; an
// array (already current) or anything else is left untouched.
function migrateColumnsToArray(events: StampedEvent[]): StampedEvent[] {
  return events.map((e) => {
    if (e.kind !== 'create' && e.kind !== 'declare-schema') return e
    const cols = e.columns
    if (!cols || Array.isArray(cols) || typeof cols !== 'object') return e
    return { ...e, columns: schemaColumns(cols as Schema) }
  })
}

const EDITABLE_MIGRATIONS: EventMigration[] = [migrateColumnsToArray]

// Re-drive a code-created table's rows from a fresh program seed, in place.
// The rule the whole feature turns on: a code row the user hasn't touched
// (code && !dirty) takes the new seed's value at its slot; a row the user
// edited or added (dirty) is left exactly as-is. Alignment is by slot, not
// position, so user-added rows interleaved among the seed don't drag values
// out of step, a shrunk seed drops only its own pristine tail, and a slot the
// user deleted stays deleted (removedSlots) rather than reappearing.
function reseedRows(t: TableState, seed: Row[]): void {
  const cols = effectiveColumns(t)
  const nextRows: Row[] = []
  const nextMeta: RowMeta[] = []
  const consumed = new Set<number>()
  // Walk existing rows in order: keep user/edited rows, refresh pristine code
  // rows from their slot's new seed value (or drop them if the seed shrank
  // past that slot).
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
  // Slots the grown seed adds that aren't already present (and weren't
  // tombstoned by a delete): append as fresh code rows.
  for (let slot = 0; slot < seed.length; slot++) {
    if (consumed.has(slot) || t.removedSlots.has(slot)) continue
    nextRows.push(conformRow(seed[slot], cols))
    nextMeta.push(seedMeta(slot))
  }
  t.rows = nextRows
  t.rowMeta = nextMeta
}

// Apply one event to the map of table states. Defensive (events may come from
// storage): unknown tables / columns / rows are ignored rather than thrown.
function applyEvent(tables: Map<string, TableState>, e: StampedEvent): void {
  const name = e.table as string
  if (e.kind === 'create') {
    if (tables.has(name)) return
    const columns = eventColumns(e.columns)
    // A DSL-originated create (ensure()'s first sight of the table) seeds
    // `declared`; a table-panel create ("+ table", or record()'s columnless
    // stream) seeds `userColumns` directly — it has no program declaring it.
    const declared = e.declared === true ? columns : null
    const seed = eventRows(e.rows)
    const t: TableState = {
      userColumns: declared ? [] : columns, removedColumns: new Set(), declared,
      rows: [], rowMeta: [], events: [eventRow(e)], log: e.log === true,
      codeCreated: e.declared === true, lastSeed: e.declared === true ? seed.map((r) => ({ ...r })) : null,
      removedSlots: new Set(),
    }
    t.rows = seed.map((r) => conformRow(r, effectiveColumns(t)))
    // A declared create's rows are the program's seed (code rows, by slot);
    // a table-panel create's rows (if any) are the user's own.
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
      // The program re-ran editable(name, schema, seedRows) with a changed
      // seed: re-drive the rows the user hasn't touched (see reseedRows). Only
      // ever appended for a code-created table (see ensure).
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
      // A rename of a declared-only column "claims" it under the new name —
      // the old declared name may still reappear (see effectiveColumns), now
      // as a fresh column, if the program keeps declaring it. The claim copies
      // the whole column, so an enum keeps its options and a code column its
      // language.
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
      // The copy takes on its own (user) identity going forward — never a code
      // row, so the program won't overwrite or drop it on a re-seed.
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

// Fold a list of events into the table-state map — the whole store's state at
// the end of that list. Folding a *prefix* of the log (see setReplayView)
// reconstructs the store as it was at an earlier run.
function foldEventsMap(events: StampedEvent[]): Map<string, TableState> {
  const tables = new Map<string, TableState>()
  for (const e of events) {
    // A single malformed event — e.g. from an older or otherwise unexpected
    // session shape — must never sink the whole load: any session with table
    // data should still open. Skip the bad event and fold the rest.
    try { applyEvent(tables, e) } catch { /* ignore an unfoldable event */ }
  }
  return tables
}

export interface EditableTableStore {
  // The underlying event log — the unit multiplayer syncs. Remote events
  // merged into it refold the store and fire onChange.
  readonly log: EventLog
  listNames(): string[]
  has(name: string): boolean
  // True for a table created via record() (see below) — a pure event stream,
  // never a row-editable table, regardless of what has()/get() report. The
  // table panel uses this to skip offering row/column editing controls for it.
  isLog(name: string): boolean
  get(name: string): EditableTableData | undefined
  createTable(name: string): void
  removeTable(name: string): void
  renameTable(name: string, newName: string): boolean
  // Called by the DSL's editable(name, schema): appends a create event on
  // first sight (optionally seeding rows), a declare-schema event when the
  // declared schema changed, and returns the folded (current) rows. The
  // effective columns are always a function of the *current* declared schema
  // plus a fold over the table's own genuine edit events (see
  // effectiveColumns/mergeColumns) — never a snapshot of "whatever the
  // columns happened to be last time". So a column that's only ever been
  // declared, never touched by the user, tracks the program's schema exactly
  // (added when declared, gone when not); a column the user added or
  // edited via the table panel survives regardless of what's declared.
  ensure(name: string, schema: Schema, seedRows?: Row[]): Row[]
  // Drop every code-created editable table whose name isn't in `keep` — the
  // program stopped declaring it, so it should stop being editable (a computed
  // view of the same name, or nothing, takes over). Only tables a program
  // brought into being via editable() are eligible: a user's "+ table", a
  // record() log stream, and "code" are never touched. Returns the names
  // removed. A no-op while replaying a past run (reads must not mutate head).
  retainDeclared(keep: Iterable<string>): string[]
  addColumn(name: string, colName: string, type: ColumnType): void
  removeColumn(name: string, colName: string): void
  setColumnType(name: string, colName: string, type: ColumnType): void
  renameColumn(name: string, colName: string, newName: string): boolean
  addRow(name: string): void
  removeRow(name: string, index: number): void
  // Insert a copy of the row at `index` immediately after it.
  duplicateRow(name: string, index: number): void
  setCell(name: string, index: number, colName: string, value: unknown): void
  // Atomically set several cells of one row in a single event — e.g. a
  // program Run sets `code` and `seed` together, so the pair is always one
  // history entry rather than two, and is never observed half-updated.
  setRow(name: string, index: number, values: Record<string, unknown>): void
  // Record an arbitrary event on `table` (auto-creating it, with no columns,
  // on first sight) — for append-only event streams that aren't user-editable
  // rows at all: an Apply bookmark, a peer joining/leaving, … (see main.ts).
  // Rides the exact same store log as every real editable table, so it's
  // covered by the same serialize/load/merge/multiplayer-sync path for free,
  // and shows up as "table·events" like any other history — multiplayer
  // syncing genuinely is just "sync the log, replay on connection," this is
  // what lets peer-connection and run/apply events ride that too instead of
  // needing a channel of their own.
  record(table: string, kind: string, payload?: Record<string, unknown>): void
  // Fired after any change event lands (a fold consumer should re-read).
  onChange(cb: () => void): void
  // --- runs (session history) ---------------------------------------------
  // Record the current per-table log indices as a new run (the Apply/Ctrl-Enter
  // bookmark) and return it. The runs are the coordinates the session bar
  // scrubs over; the serialized list rides alongside the event data in a saved
  // session (see sessions.ts).
  recordRun(): SessionRun
  runs(): SessionRun[]
  setRuns(runs: SessionRun[]): void
  // --- branches -----------------------------------------------------------
  // Commit the pending edits as a new apply node — the branch-aware successor
  // to recordRun (the apply event *is* the run). Fast-forwards `parent` onto
  // the current branch tip (so concurrent peer applies fold in order), unless
  // the store is in a forked state (an edit landed while scrubbed), in which
  // case `parent` is the scrubbed node and `seen` the tip it forked away from
  // — making the apply read as a fork (seen != parent). `payload` carries the
  // apply's display fields (changed/at). Returns the new node.
  recordApply(payload?: Record<string, unknown>): ApplyNode | null
  // The branch tree folded from the log's apply events (cached; invalidated by
  // any change) — the GUI's window onto the branch structure.
  branchTree(): BranchTree
  // The apply id the live fold currently shows (its branch's tip, or the node
  // scrubbed/forked to), or null for a fresh/legacy log with no applies.
  currentHead(): string | null
  // root..head applies on the current branch — the session bar's scrub axis
  // (applies at or before the latest clear-runs marker are hidden, as runs are).
  branchPath(): ApplyNode[]
  // Switch the live fold to another branch head: refold its events, drop any
  // un-applied working tail, and make its tip the current head. The way "get
  // back to an old branch" is expressed; continuing it is just applying.
  checkout(headId: string): void
  // Reconstruct runs from a legacy session that saved no run list, one per
  // recorded program Run in "code"'s own history (best-effort backward compat).
  // Stops at the latest CLEAR_RUNS_KIND marker, if any, so a cleared session
  // that got saved without an explicit (now-empty) run list doesn't derive its
  // pre-clear runs back into existence.
  deriveRunsFromCode(): void
  // Show the store as it was at a past point — reads (get/has/listNames/ensure)
  // serve that historical fold and ensure() appends nothing, so a scrubbed
  // replay is a pure preview. `null` returns to the live head. The coordinate
  // is either an apply node id (branch-aware: folds that apply's branch up to
  // it) or a legacy SessionRun (a log prefix). A real mutation while scrubbed
  // to a *node* forks (see fork-on-edit); while on a legacy run it edits the
  // head, exactly as before branches.
  setReplayView(target: SessionRun | string | null): void
  // The whole store as one serialized blob (every table's events) — the event
  // data half of what a session persists (runs are the other half). load()
  // replaces the store's entire history and re-folds every table from scratch,
  // resetting runs; clear() empties it. Both notify like any other change.
  serialize(): string
  load(json: string | unknown): boolean
  clear(): void
}

export function createEditableTableStore({ src }: { src?: string } = {}): EditableTableStore {
  const log = createEventLog({ src, migrations: EDITABLE_MIGRATIONS })
  // The live head fold, kept incrementally: append() applies the new event to
  // this map. Always the full log — replay views are separate (below).
  let tables = new Map<string, TableState>()
  // The recorded runs (Apply bookmarks) — the *legacy* linear scrub coordinates,
  // kept for sessions that predate branches and for session-format round-trips
  // (see recordRun/SessionRun). The branch tree (below) is the live coordinate.
  let runs: SessionRun[] = []
  // When set (a scrubbed replay), reads serve this historical fold instead of
  // `tables`, and ensure() is read-only. Null = live head.
  let replay: Map<string, TableState> | null = null
  // The apply node id the replay view shows (branch-aware scrub), or null for a
  // legacy SessionRun replay (or no replay). Editing while this is set forks.
  let replayNode: string | null = null

  // --- branch state -----------------------------------------------------------
  // `head` is the apply whose branch the live fold shows (null = fresh/legacy
  // log). `pending` is the working tail — keys of events appended since `head`,
  // the un-applied edits the next apply will claim. `forked` records that the
  // live fold was promoted from a scrubbed replay (an edit landed while scrubbed
  // back), so the next apply parents the scrubbed node and reads as a fork;
  // `seenTip` is the branch tip it forked away from (the apply's `seen`).
  let head: string | null = null
  let pending: string[] = []
  let forked = false
  let seenTip: string | null = null
  // The branch tree, folded lazily from the log and invalidated on any change.
  let treeCache: BranchTree | null = null
  const branchTree = (): BranchTree => (treeCache ??= buildBranchTree(log.all()))
  const invalidateTree = (): void => { treeCache = null }

  const listeners: (() => void)[] = []
  const notify = (): void => listeners.forEach((cb) => cb())

  // Which fold reads resolve against — the replay view while scrubbing, else head.
  const view = (): Map<string, TableState> => replay ?? tables

  // Follow the linearized non-fork chain down from `id` to its branch tip — the
  // node an ordinary apply fast-forwards its parent onto (peer applies that
  // merged in since `head` chain ahead of it).
  function branchTip(id: string, tree: BranchTree): string {
    let cur = id
    for (;;) {
      const next = (tree.children.get(cur) ?? []).find((k) => !tree.nodes.get(k)!.fork)
      if (!next) return cur
      cur = next
    }
  }

  // The newest apply on any branch (by seq, src) — the performance head peers
  // follow, and the parent for the first apply on a legacy/fresh log.
  function newestApplyId(tree: BranchTree): string | null {
    let best: ApplyNode | null = null
    for (const n of tree.nodes.values()) {
      if (!best || n.seq > best.seq || (n.seq === best.seq && n.src > best.src)) best = n
    }
    return best?.id ?? null
  }

  // Rebuild the live fold from `head`'s branch — used on checkout and merge,
  // where the incremental head-fold can't absorb the change. With head null
  // (legacy/fresh) branchEvents returns the whole log, i.e. today's behavior.
  function refoldBranch(): void {
    tables = foldEventsMap(branchEvents(log.all(), head, branchTree()))
  }

  // The working tail derived from the log alone: non-apply events that no apply
  // claims, ordered after the newest apply. It's how `pending` reattaches to the
  // right branch after a reload mid-edit (the session record persists no pending
  // list of its own yet), matching the overlay branchEvents shows for a leaf.
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

  function append(payload: Record<string, unknown> & { kind: string; table: string }): void {
    // Fork-on-edit: a mutation while scrubbed to an apply node lands on the
    // state being *looked at*. Promote that replay fold to the live fold, point
    // head at the scrubbed node (remembering the tip we came from for `seen`),
    // and discard the abandoned working tail — the old branch's applies still
    // claim their events, so nothing is rewritten.
    if (replay !== null && replayNode !== null && head !== null) {
      seenTip = branchTip(head, branchTree())
      head = replayNode
      forked = true
      pending = []
      tables = replay
    }
    replay = null
    replayNode = null
    const e = log.append(payload)
    applyEvent(tables, e)
    // Every ordinary event joins the working tail so the next apply claims it —
    // including record()'s markers (session-start, the activity create), so the
    // first apply wholesale-claims a legacy/fresh log's prior events too. Apply
    // events are the commits themselves, never their own pending.
    if (e.kind !== APPLY_KIND) pending.push(eventKey(e))
    invalidateTree()
    notify()
  }

  // Remote events (multiplayer) can land between existing ones, so the
  // incremental fold can't absorb them — rebuild from the branch fold. An
  // in-progress replay is dropped (a prefix's meaning can shift under it), and
  // a forked-but-uncommitted state is reset. When a peer's *apply* merges in,
  // follow it: the performance head is the newest apply on any branch, so peers
  // stay together (their next local edit forks if they'd checked out elsewhere).
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
    // Drop from the working tail anything a merged apply now claims (a peer
    // committed edits it had seen from us).
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
      // New tables start with "beat" and "loop" columns — the convention every
      // other table here keys time by: a 1-indexed beat within the loop, and
      // which 0-indexed pass of the loop for multi-loop sequences.
      append({ kind: 'create', table: name, columns: [{ name: 'beat', type: 'number' }, { name: 'loop', type: 'number' }] })
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
      // Replay is a read-only preview: a cook running against a past run must
      // not append create/declare-schema events. Serve the historical rows
      // (or the seed, if the program references a table that didn't exist at
      // that run).
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
      // Re-drive the code rows when the program's seed changed (and only for a
      // table the program created — a user's "+ table" keeps whatever it holds).
      // Unchanged seeds stay silent, exactly like an unchanged schema, so an
      // ordinary Run of the same code appends nothing.
      const t = tables.get(name)!
      if (t.codeCreated && seedRows !== undefined && JSON.stringify(seedRows) !== JSON.stringify(t.lastSeed)) {
        append({ kind: 'seed-rows', table: name, rows: seedRows })
      }
      // A user-disabled row is omitted here — as if that line were commented
      // out — but stays in the table itself (see get()) for re-enabling later.
      return visibleRows(tables.get(name)!)
    },

    retainDeclared(keep: Iterable<string>): string[] {
      if (replay) return []
      const keepSet = new Set(keep)
      const removed: string[] = []
      for (const [name, t] of tables) {
        // "code" is code-created too but is the program itself, never a
        // program-declared side table — never prune it.
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
        // A deliberate fork: parent is the scrubbed node (don't fast-forward
        // past it), seen the tip we came from — so seen != parent.
        parent = head
        seen = seenTip ?? head
      } else {
        // An ordinary apply fast-forwards onto the current branch tip, so
        // seen == parent even if peer applies merged in since our last apply.
        parent = head !== null ? branchTip(head, tree) : newestApplyId(tree)
        seen = parent
      }
      const id = mintApplyId()
      const edits = pending.slice()
      // The apply rides the "activity" table like every marker — ensure it
      // exists first (an apply on an unknown table would be dropped by the fold).
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
      // Hide applies at or before the latest clear marker from the scrub axis,
      // the same way a Clear hides runs — the fold still uses the full path.
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

    setReplayView(target: SessionRun | string | null): void {
      if (target === null) {
        replay = null
        replayNode = null
      } else if (typeof target === 'string') {
        // Branch-aware scrub: fold that apply's branch up to it. A leaf (the
        // live tip) overlays the working tail; a scrubbed-back node does not.
        replayNode = target
        replay = foldEventsMap(branchEvents(log.all(), target, branchTree()))
      } else {
        // Legacy SessionRun: a log prefix (editing while here edits the head).
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
      // Adopt the newest apply as the head so a saved branching session opens on
      // its latest branch; a legacy log has none, so head stays null (linear).
      head = newestApplyId(branchTree())
      seenTip = head
      // Reattach any un-applied working tail so the next apply claims it (and it
      // stays visible), derived from the log since no pending list is persisted.
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
