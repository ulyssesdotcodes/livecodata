import { EditorView, basicSetup } from 'codemirror'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap, hoverTooltip } from '@codemirror/view'
import { Prec, Compartment } from '@codemirror/state'
import { vim } from '@replit/codemirror-vim'
import { buildTablePreview } from './preview.js'
import { isExprDot } from './completion.js'
import { SAMPLES } from './samples.js'
import type { Table } from './dsl.js'

interface DocEntry {
  sig: string
  detail: string
  info: string
}

const DSL_BUILTIN_DOCS: Record<string, DocEntry> = {
  define:     { sig: 'define(name, fn)',             detail: 'register view',    info: 'Register a named view. fn receives (rand, table) and must return a Table. Views are cooked lazily; deps tracked via table().' },
  table:      { sig: 'table(name)',                  detail: 'resolve view',     info: 'Resolve a named view at top-level (no dependency tracking). Returns the cooked Table for that view.' },
  math:       { sig: 'math(beat => value)',          detail: 'sample function',  info: 'Sample a numeric function of elapsed beats. Chain .range(beats) to emit rows of { beat, value }.' },
  rows:       { sig: 'rows([{...}, ...])',           detail: 'wrap array',       info: 'Wrap a literal array of plain objects into a Table.' },
  data:       { sig: 'data(url)',                     detail: 'fetch dataset',    info: 'Load a pre-fetched CSV file by URL into a Table. Files in /data/ are served statically; the runtime fetches them before cooking.' },
  csv:        { sig: 'csv(string)',                  detail: 'parse CSV',        info: 'Parse a CSV string (header row + data rows) into a Table.' },
  json:       { sig: 'json(array | string)',         detail: 'parse JSON',       info: 'Wrap a JS array or parse a JSON string into a Table.' },
  grid:       { sig: 'grid(cols, rows)',             detail: 'XZ lattice',       info: 'Generate a cols×rows lattice of XZ positions as a Table (fields: col, row, x, z).' },
  physics:    { sig: 'physics(table)',               detail: 'physics scene',    info: 'Load a base scene table into the JoltPhysics engine. Chain .simulate() to run the simulation.' },
  editable:   { sig: 'editable(name, schema, seedRows?)', detail: 'user table', info: 'A user-editable table: rows are edited in the table panel, not computed — every edit is an appended event and the visible table is the fold (see the name·events tab). schema maps column name to "number" | "string" | "boolean" | "code"; code cells open in this editor. seedRows fill the table when first created.' },
  field:      { sig: 'field(name)',                   detail: 'expr: read field',  info: 'A chainable expression reading row[name]. Chain .add/.sub/.mul/.div/.mod, .eq/.gt/…, .and/.or/.not, .cond(a,b). Use in filter(expr), map(template), emit(template), derive — these are diffable (no opaque closures).' },
  lit:        { sig: 'lit(value)',                   detail: 'expr: literal',     info: 'A constant expression. Usually you can pass a raw value directly to an Expr method.' },
  idx:        { sig: 'idx()',                         detail: 'expr: row index',   info: 'An expression yielding the row index (0-based).' },
  midi:       { sig: 'midi(note, channel?)',         detail: 'expr: live MIDI',   info: 'A live value from the streaming MIDI table — the most recent event for `note` (e.g. "c4", "c#4", or "cc1" for control change) at-or-before the playhead. Normalized 0–1 (note velocity / CC value). Chainable like any Expr: midi("c4").mul(2). Use in setField/map/derive; it resolves each frame, so notes you play while looping replay at the loop position they were heard. Optional 1-based `channel` filters to one channel.' },
  beats:      { sig: 'beats(count, { fit }?)',       detail: 'beat timeline',     info: 'A timeline that loops every `count` beats. Tempo is automatic — the playhead always runs at the tapped tempo (Tap) — so this is a RETIME: define("timeline", () => beats(16)) just loops every 16 beats; { fit: beats } stretches a span of source beats across the window (e.g. beats(16, { fit: 8 }) plays 8 beats of content at half speed).' },
  tempo:      { sig: 'tempo(fallback?)',             detail: 'beat length (s)',   info: 'Seconds per beat derived from the tap-beat table (Tap), or `fallback` (default 0.5s = 120 BPM) until two taps are recorded.' },
  taps:       { sig: 'taps()',                       detail: 'tap-beat table',    info: 'The tap-beat table: one row per wall-time button press ({ beat, time }, time as an absolute UTC epoch ms).' },
  linear:     { sig: 'linear',                       detail: 'easing curve',     info: 'Linear easing (t → t). Pass as the ease field of a color-pulse row.' },
  easeIn:     { sig: 'easeIn',                       detail: 'easing curve',     info: 'Quadratic ease-in (t → t²). Starts slow, ends fast.' },
  easeOut:    { sig: 'easeOut',                      detail: 'easing curve',     info: 'Quadratic ease-out (t → 1-(1-t)²). Starts fast, ends slow.' },
  easeInOut:  { sig: 'easeInOut',                    detail: 'easing curve',     info: 'Quadratic ease-in-out. Slow at both ends, fast in the middle.' },
}

const TABLE_METHOD_DOCS: Record<string, DocEntry> = {
  map:         { sig: '.map(row => row | template)',          detail: 'transform rows',   info: 'Transform every row. Pass a function, or a declarative template of Expr/literals (e.g. { y: field("v").mul(2) }) — the template form is diffable.' },
  filter:      { sig: '.filter(row => bool | Expr)',          detail: 'keep rows',        info: 'Keep rows where the predicate holds. Pass a function, or an Expr predicate (e.g. field("type").eq("collision")) — the Expr form is diffable.' },
  filterMap:   { sig: '.filterMap(row => row | null)',        detail: 'filter + map',     info: 'Map and filter in one pass — return a new row to keep it, null/undefined to drop it. (For a diffable form, use .filter(Expr).emit(template).)' },
  emit:        { sig: '.emit(template | [templates])',        detail: 'fan out rows',     info: 'Declarative flatMap: emit one or many rows per source row from Expr/literal templates. The diffable counterpart of filterMap; pair with .filter(Expr).' },
  concat:      { sig: '.concat(other)',                       detail: 'combine tables',   info: 'Append the rows of another Table (or array) to this one.' },
  slice:       { sig: '.slice(start, end?)',                  detail: 'subset rows',      info: 'Return a sub-range of rows, like Array.slice.' },
  fold:        { sig: '.fold(init, (acc, row) => acc)',       detail: 'reduce to value',  info: 'Reduce all rows to a single accumulated value, like Array.reduce.' },
  scan:        { sig: '.scan(init, (acc, row) => row)',       detail: 'running accumul.', info: 'Running accumulator — emit one output row per input row, carrying state forward.' },
  join:        { sig: '.join(other, on)',                     detail: 'key join',         info: 'Key-based join: merge rows where the `on` field (or key fn) matches. Like SQL LEFT JOIN.' },
  zip:         { sig: '.zip(other)',                          detail: 'positional join',  info: 'Merge rows positionally — row 0 with row 0, row 1 with row 1, etc.' },
  orderBy:     { sig: '.orderBy(field | fn, dir?)',           detail: 'sort rows',        info: 'Sort rows by a field name or comparator function. Optional dir: "asc" (default) or "desc".' },
  derive:      { sig: '.derive({ field: row => val })',       detail: 'add fields',       info: 'Add or overwrite fields on every row using derivation functions.' },
  assign:      { sig: '.assign({ field: value })',            detail: 'set fields',       info: 'Merge a fixed object of field values into every row.' },
  setField:    { sig: '.setField(name, value)',               detail: 'set one field',    info: 'Set one field on every row from an Expr or value. With a live source — .setField("amount", midi("c4")) — the field becomes a per-frame binding that follows the note as the loop replays; a constant Expr is baked in immediately.' },
  mapField:    { sig: '.mapField(field, val => val)',         detail: 'transform field',  info: 'Apply a function to one field of every row, replacing it in place.' },
  rescale:     { sig: '.rescale(field, [min, max]?)',         detail: 'normalize field',  info: 'Normalize a numeric field to [0, 1] (or a custom range) across all rows.' },
  lag:         { sig: '.lag(n)',                              detail: 'shift rows',       info: 'Shift rows forward by n positions, padding the start with null rows.' },
  retime:      { sig: '.retime({ offset, scale } | beat => beat)', detail: 'move on beat axis', info: 'Shift a table along the beat axis. Declarative retime({ offset, scale }) moves every row by `offset` beats and stretches spacing about beat 1 by `scale` (durations too) — diffable. Or pass a function beat => newBeat to remap arbitrarily.' },
  shift:       { sig: '.shift(beats)',                        detail: 'delay by beats',   info: 'Shift every row later by `beats` (negative = earlier). Sugar for .retime({ offset: beats }).' },
  groupBy:     { sig: '.groupBy(field | fn)',                 detail: 'group rows',       info: 'Group rows by a key field or function. Chain .agg() or .count() to aggregate.' },
  agg:         { sig: '.agg({ field: rows => val })',         detail: 'aggregate groups', info: 'Aggregate each group into one row. Called after .groupBy().' },
  count:       { sig: '.count()',                             detail: 'count groups',     info: 'Emit one row per group with a `count` field. Called after .groupBy().' },
  trigger:     { sig: '.trigger(pred, emit)',                 detail: 'event detection',  info: 'When pred(row) is true, call emit(row) and include returned rows in the output.' },
  triggerEach: { sig: '.triggerEach(pred, objs, make)',       detail: 'fan-out events',   info: 'Fan out: for each object in objs when pred fires, call make(row, obj) to emit rows.' },
  crossings:   { sig: '.crossings(field, level)',             detail: 'threshold events', info: 'Emit one row each time the named field crosses the given numeric level.' },
  range:       { sig: '.range(beats)',                        detail: 'generate rows',    info: 'Emit rows over `beats` beats from a math() builder — each row has { beat, value }.' },
  rasterize:   { sig: '.rasterize(maxBeats?)',                detail: 'bake frame cache', info: 'Bake sparse event rows (keyed by `beat`) into a dense per-frame world state Table. Optional maxBeats sets the length; omitted, it sizes to the last event.' },
  simulate:    { sig: '.simulate({ steps, gravity, ... })',   detail: 'run physics',      info: 'Step the JoltPhysics world. Options: steps (frames), gravity, fps, sampleEvery, collisions.' },
  graph:       { sig: '.graph(...columns)',                   detail: 'draw graph',       info: 'Mark this Table to be drawn on the graph panel. Pass column name(s) to plot.' },
  save:        { sig: '.save(name)',                          detail: 'save as view',     info: 'Sugar for define(name, () => this) — register the current Table as a named view.' },
}

// Methods offered after a dot on an Expr (field("x").add(1).gt(2)…). Every Expr
// method returns an Expr, so a chain rooted at field()/lit()/idx() stays Expr.
const EXPR_METHOD_DOCS: Record<string, DocEntry> = {
  add:  { sig: '.add(x)',           detail: 'expr  +',   info: 'Add. x is another Expr or a number.' },
  sub:  { sig: '.sub(x)',           detail: 'expr  −',   info: 'Subtract x (Expr or number).' },
  mul:  { sig: '.mul(x)',           detail: 'expr  ×',   info: 'Multiply by x (Expr or number).' },
  div:  { sig: '.div(x)',           detail: 'expr  ÷',   info: 'Divide by x (Expr or number).' },
  mod:  { sig: '.mod(x)',           detail: 'expr  %',   info: 'Modulo (remainder) by x.' },
  eq:   { sig: '.eq(x)',            detail: 'expr  ===', info: 'Strict-equal test. Returns a boolean Expr (use in filter / cond).' },
  ne:   { sig: '.ne(x)',            detail: 'expr  !==', info: 'Not-equal test. Returns a boolean Expr.' },
  gt:   { sig: '.gt(x)',            detail: 'expr  >',   info: 'Greater-than test. Returns a boolean Expr.' },
  gte:  { sig: '.gte(x)',           detail: 'expr  >=',  info: 'Greater-than-or-equal test. Returns a boolean Expr.' },
  lt:   { sig: '.lt(x)',            detail: 'expr  <',   info: 'Less-than test. Returns a boolean Expr.' },
  lte:  { sig: '.lte(x)',           detail: 'expr  <=',  info: 'Less-than-or-equal test. Returns a boolean Expr.' },
  and:  { sig: '.and(expr)',        detail: 'expr  &&',  info: 'Logical AND of two boolean Exprs.' },
  or:   { sig: '.or(expr)',         detail: 'expr  ||',  info: 'Logical OR of two boolean Exprs.' },
  not:  { sig: '.not()',            detail: 'expr  !',   info: 'Logical negation of a boolean Expr.' },
  cond: { sig: '.cond(then, else)', detail: 'ternary',   info: 'If this Expr is truthy yield `then`, else `else` (each an Expr or literal).' },
}

function makeInfoNode(sig: string, info: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-completion-info'
  const sigEl = document.createElement('code')
  sigEl.textContent = sig
  const desc = document.createElement('p')
  desc.textContent = info
  el.appendChild(sigEl)
  el.appendChild(desc)
  return el
}

const DSL_BUILTINS = Object.keys(DSL_BUILTIN_DOCS)

function viewAtPos(text: string, pos: number): string | null {
  const re = /\bdefine\(\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  let name: string | null = null
  while ((m = re.exec(text))) {
    if (m.index <= pos) name = m[1]
    else break
  }
  return name
}

function dslCompletions(getViews?: () => Map<string, Table> | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (context: any) => {
    if (context.matchBefore(/\b(?:table|define)\(\s*"[^"]*/)) {
      const open = context.matchBefore(/"[^"]*/)
      const names = [...(getViews?.() ?? new Map()).keys()]
      if (!names.length) return null
      return {
        from: open ? open.from + 1 : context.pos,
        options: names.map((n: string) => ({ label: n, type: 'variable' })),
        validFor: /^[^"]*$/,
      }
    }
    const dot = context.matchBefore(/\.\w*/)
    if (dot) {
      // Pick the method set by the chain's root: Expr methods after field()/lit()/
      // idx() (and their chains), Table methods otherwise.
      const docs = isExprDot(context.state.doc.toString() as string, dot.from as number)
        ? EXPR_METHOD_DOCS : TABLE_METHOD_DOCS
      return {
        from: dot.from + 1,
        options: Object.keys(docs).map((label) => {
          const d = docs[label]
          return { label, type: 'method', detail: d.detail, info: () => makeInfoNode(d.sig, d.info) }
        }),
        validFor: /^\w*$/,
      }
    }
    const word = context.matchBefore(/\w+/)
    if (!word && !context.explicit) return null
    return {
      from: word ? word.from : context.pos,
      options: DSL_BUILTINS.map((label) => {
        const d = DSL_BUILTIN_DOCS[label]
        return { label, type: 'function', detail: d.detail, info: () => makeInfoNode(d.sig, d.info) }
      }),
      validFor: /^\w*$/,
    }
  }
}

export const defaultProgram = SAMPLES[0].code

function dslHover(getViews?: () => Map<string, Table> | undefined, getPlayIndex?: () => number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return hoverTooltip((view: any, pos: number) => {
    const line = view.state.doc.lineAt(pos) as { text: string; from: number }
    const re = /"([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line.text))) {
      const start = line.from + m.index
      const end = start + m[0].length
      if (pos < start || pos > end) continue
      const table = (getViews?.() ?? new Map()).get(m[1])
      if (!table) return null
      return {
        pos: start, end, above: true,
        create: () => ({ dom: buildTablePreview(table, { playIndex: getPlayIndex?.() }) }),
      }
    }
    return null
  })
}

export interface EditorOptions {
  onRun?: (code: string, opts: { setError: (msg: string | null) => void }) => void
  getViews?: () => Map<string, Table>
  onCaretView?: (name: string) => void
  getPlayIndex?: () => number
  // Initial vim-keybindings state (persisted by the caller — see settings.ts).
  vimMode?: boolean
  onVimModeChange?: (enabled: boolean) => void
}

export interface EditorAPI {
  run(): void
  getCode(): string
  setCode(code: string): void
  setError(msg: string | null): void
  // Point the editor at a single table cell (e.g. hydra[0].code): the program
  // text is stashed, the cell's text loads, and Run/Ctrl-Enter calls onCommit
  // with the current text instead of running the program. The "Back" button
  // (or an external setCode) returns to the program.
  editCell(label: string, code: string, onCommit: (text: string) => void): void
}

export function initEditor(parent: HTMLElement, { onRun, getViews, onCaretView, getPlayIndex, vimMode = true, onVimModeChange }: EditorOptions = {}): EditorAPI {
  parent.innerHTML = ''

  const header = document.createElement('div')
  header.className = 'editor-header'

  const collapseBtn = document.createElement('button')
  collapseBtn.className = 'collapse-btn'
  header.appendChild(collapseBtn)

  const titleEl = document.createElement('span')
  titleEl.className = 'editor-title'
  titleEl.textContent = 'DSL'
  header.appendChild(titleEl)

  const backBtn = document.createElement('button')
  backBtn.className = 'editor-back-btn'
  backBtn.textContent = 'Back'
  backBtn.title = 'Back to the program'
  backBtn.style.display = 'none'
  header.appendChild(backBtn)

  const runBtn = document.createElement('button')
  runBtn.className = 'run-btn'
  runBtn.textContent = 'Run'
  header.appendChild(runBtn)

  // Settings: currently just the vim-mode toggle. A small popover rather than
  // a plain toggle button so more prefs can land here later without another
  // header slot. Positioned fixed (not absolute) so it isn't clipped by
  // #editor-pane's overflow:hidden when the panel is collapsed to header height.
  const settingsWrap = document.createElement('div')
  settingsWrap.className = 'settings-wrap'

  const settingsBtn = document.createElement('button')
  settingsBtn.className = 'settings-btn'
  settingsBtn.textContent = '⚙'
  settingsBtn.title = 'Settings'
  settingsBtn.setAttribute('aria-label', 'Settings')
  settingsWrap.appendChild(settingsBtn)

  const settingsMenu = document.createElement('div')
  settingsMenu.className = 'settings-menu'
  settingsWrap.appendChild(settingsMenu)

  const vimRow = document.createElement('label')
  vimRow.className = 'settings-row'
  const vimCheckbox = document.createElement('input')
  vimCheckbox.type = 'checkbox'
  vimCheckbox.checked = vimMode
  vimRow.appendChild(vimCheckbox)
  vimRow.appendChild(document.createTextNode('Vim mode'))
  settingsMenu.appendChild(vimRow)

  header.appendChild(settingsWrap)

  function positionSettingsMenu(): void {
    const r = settingsBtn.getBoundingClientRect()
    settingsMenu.style.top = `${r.bottom + 4}px`
    settingsMenu.style.right = `${window.innerWidth - r.right}px`
  }

  settingsBtn.onclick = (e) => {
    e.stopPropagation()
    const opening = !settingsMenu.classList.contains('open')
    if (opening) positionSettingsMenu()
    settingsMenu.classList.toggle('open', opening)
  }

  document.addEventListener('click', (e) => {
    if (!settingsWrap.contains(e.target as Node)) settingsMenu.classList.remove('open')
  })

  parent.appendChild(header)

  function setCollapsed(collapsed: boolean): void {
    parent.classList.toggle('editor-collapsed', collapsed)
    collapseBtn.textContent = collapsed ? '▸' : '▾'
    collapseBtn.setAttribute('aria-label', collapsed ? 'Expand code panel' : 'Collapse code panel')
  }

  collapseBtn.onclick = () => setCollapsed(!parent.classList.contains('editor-collapsed'))
  setCollapsed(window.matchMedia('(max-width: 767px)').matches)

  const host = document.createElement('div')
  host.className = 'editor-host'
  parent.appendChild(host)

  const errEl = document.createElement('div')
  errEl.className = 'editor-error'
  errEl.style.display = 'none'
  parent.appendChild(errEl)

  function setError(msg: string | null): void {
    if (msg) {
      errEl.textContent = msg
      errEl.style.display = 'block'
    } else {
      errEl.textContent = ''
      errEl.style.display = 'none'
    }
  }

  // When set, the editor is a window onto one table cell rather than the
  // program: Run commits the text back to the cell (an event append upstream).
  let cellTarget: { label: string; onCommit: (text: string) => void } | null = null
  let stashedProgram = ''

  function run(): void {
    const text = view.state.doc.toString()
    if (cellTarget) cellTarget.onCommit(text)
    else onRun?.(text, { setError })
  }

  function setDoc(code: string): void {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } })
  }

  function exitCell(restoreProgram: boolean): void {
    if (!cellTarget) return
    cellTarget = null
    titleEl.textContent = 'DSL'
    runBtn.textContent = 'Run'
    backBtn.style.display = 'none'
    if (restoreProgram) setDoc(stashedProgram)
  }

  function editCell(label: string, code: string, onCommit: (text: string) => void): void {
    if (!cellTarget) stashedProgram = view.state.doc.toString()
    cellTarget = { label, onCommit }
    titleEl.textContent = label
    runBtn.textContent = 'Apply'
    backBtn.style.display = ''
    setDoc(code)
    view.focus()
  }

  backBtn.onclick = () => exitCell(true)

  let lastCaretView: string | null = null

  const vimCompartment = new Compartment()

  const view = new EditorView({
    doc: defaultProgram,
    extensions: [
      vimCompartment.of(vimMode ? [vim()] : []),
      basicSetup,
      javascript(),
      javascriptLanguage.data.of({ autocomplete: dslCompletions(getViews) }),
      EditorView.updateListener.of((u) => {
        if (!onCaretView || !(u.selectionSet || u.docChanged)) return
        const name = viewAtPos(u.state.doc.toString(), u.state.selection.main.head)
        if (name && name !== lastCaretView) {
          lastCaretView = name
          onCaretView(name)
        }
      }),
      dslHover(getViews, getPlayIndex),
      oneDark,
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', run: () => { run(); return true } },
      ])),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ],
    parent: host,
  })

  runBtn.onclick = run

  vimCheckbox.onchange = () => {
    const enabled = vimCheckbox.checked
    view.dispatch({ effects: vimCompartment.reconfigure(enabled ? [vim()] : []) })
    onVimModeChange?.(enabled)
  }

  // External loads (session scrub, examples) always mean "show the program" —
  // leave any cell target without restoring its stash (the new code wins).
  function setCode(code: string): void {
    exitCell(false)
    setDoc(code)
  }

  return { run, getCode: () => view.state.doc.toString(), setCode, setError, editCell }
}
