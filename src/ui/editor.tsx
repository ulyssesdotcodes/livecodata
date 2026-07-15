// Code editor pane. Split humble-object style: createEditor is the
// controller — it owns the CodeMirror view (an imperative DOM island, created
// detached and adopted by the component's host div), the cell-target
// bookkeeping, and the chrome state signals; <EditorPane> renders the pane —
// header, Run/Back buttons, settings popover, error strip — from that
// controller and forwards clicks back into it. All editor *logic* —
// completion/hover sources, docs — lives in ../editor-support.ts.

import { createSignal, Show, type Accessor, type JSX } from 'solid-js'
import { listenGlobal, mountComponent } from './dom.js'
import { EditorView, basicSetup } from 'codemirror'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { LanguageSupport } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap } from '@codemirror/view'
import { Prec, Compartment } from '@codemirror/state'
import { vim } from '@replit/codemirror-vim'
import {
  viewNameCompletions, codeCompletions, typeHover, signatureHelp, dslHover,
  viewAtPos, defaultProgram, defaultTables,
  remoteCursorField, setRemoteCursorsEffect, PROGRAM_CELL,
  type RemoteCursor, type SymbolCardData, type SigCardFactory,
} from '../editor-support.js'
import { createLangClient, type LangClient } from '../lang-client.js'
import type { LangSignatureHelp, EditorLang } from '../lang-service.js'
import { buildTablePreview } from './table-preview.js'
import { DocsPopover } from './docs-popover.js'
import type { Table } from '../dsl.js'

export { defaultProgram, defaultTables, PROGRAM_CELL }
export type { RemoteCursor }

// The TypeScript language service, in its own worker (see lang-worker.ts):
// one per page, shared by every editor instance, created lazily on the first
// editor. If the worker can't come up the client reports 'failed' and the
// editor falls back to the heuristic completions.
let langClient: LangClient | null = null
function getLangClient(): LangClient | null {
  if (langClient) return langClient
  try {
    const worker = new Worker(new URL('lang-worker.js', import.meta.url), { type: 'module' })
    langClient = createLangClient(worker)
  } catch (err) {
    console.error('language service unavailable:', err)
  }
  return langClient
}

// Completion info card, rendered by Solid into a detached node for CodeMirror
// to adopt (and dispose of) as tooltip content.
function makeInfoNode(sig: string, info: string): () => { dom: HTMLElement; destroy: () => void } {
  return () => {
    const { el, dispose } = mountComponent(() => (
      <div class="cm-completion-info">
        <code>{sig}</code>
        <p>{info}</p>
      </div>
    ))
    return { dom: el, destroy: dispose }
  }
}

// A resolved symbol's card — the full signature from the language service on
// top, curated DSL prose (when the name is surface API) below. Used by both
// completion info tooltips and the hover tooltip.
function makeSymbolCard({ display, docs, curated }: SymbolCardData): { dom: HTMLElement; destroy: () => void } {
  const { el, dispose } = mountComponent(() => (
    <div class="cm-completion-info cm-symbol-card">
      <Show when={display}><code>{display}</code></Show>
      <Show when={docs}><p>{docs}</p></Show>
      <Show when={curated}><p>{curated!.info}</p></Show>
    </div>
  ))
  return { dom: el, destroy: dispose }
}

// Signature-help card: the active overload with the active parameter
// highlighted, plus that parameter's docs when it has any.
const makeSigCard: SigCardFactory = (sig: LangSignatureHelp) => {
  const item = sig.signatures[Math.min(sig.activeSignature, sig.signatures.length - 1)]
  const active = sig.activeParameter
  const { el, dispose } = mountComponent(() => (
    <div class="cm-signature-help">
      <code>
        {item.prefix}
        {item.params.map((p, i) => (
          <>
            {i > 0 ? item.separator : ''}
            <span classList={{ 'cm-signature-param-active': i === active }}>{p.label}</span>
          </>
        ))}
        {item.suffix}
      </code>
      <Show when={sig.signatures.length > 1}>
        <span class="cm-signature-overloads">+{sig.signatures.length - 1} overload{sig.signatures.length > 2 ? 's' : ''}</span>
      </Show>
      <Show when={item.params[active]?.docs}>
        <p>{item.params[active].docs}</p>
      </Show>
    </div>
  ))
  return { dom: el, destroy: dispose }
}

export interface EditorOptions {
  onRun?: (code: string, opts: { setError: (msg: string | null) => void }) => void
  getViews?: () => Map<string, Table>
  onCaretView?: (name: string) => void
  getPlayIndex?: () => number
  // Initial vim-keybindings state (persisted by the caller — see settings.ts).
  vimMode?: boolean
  onVimModeChange?: (enabled: boolean) => void
  // Initial MIDI-enabled state (persisted by the caller — see settings.ts).
  // Defaults to off: enabling it is what triggers the browser's MIDI
  // permission prompt (see main.ts).
  midiEnabled?: boolean
  onMidiEnabledChange?: (enabled: boolean) => void
  // Settings-menu "Reset visuals" button: hydra occasionally wedges into a
  // stuck error state that a canvas resize/regl refresh clears — this lets
  // that recovery be triggered manually instead of resizing the window.
  onResetHydra?: () => void
  // Multiplayer presence: fired (per selection/doc update, and on cell-target
  // changes) with the cell this editor is a window onto — "code[0].code" for
  // the main program — and the cursor offset.
  onCursor?: (cell: string, head: number) => void
  // Multiplayer live typing: fired with the full buffer on doc changes the
  // *user* made (typing, paste, undo — anything not from a programmatic
  // setCode/editCell), so peers can mirror in-progress code. The receiving
  // side pushes remote buffers back in via setCode, which this deliberately
  // does not re-announce — that would echo every mirrored keystroke back.
  onEdit?: (cell: string, code: string) => void
}

export interface EditorAPI {
  run(): void
  getCode(): string
  setCode(code: string): void
  setError(msg: string | null): void
  // Point the editor at a single table cell (e.g. hydra[0].code): the program
  // text is stashed, the cell's text loads, and Run/Ctrl-Enter calls onCommit
  // with the current text instead of running the program. The "Back" button
  // (or an external setCode) returns to the program. `lang` picks which
  // surface completions/hover run against — 'hydra' for hydra sketch cells,
  // default 'dsl'.
  editCell(label: string, code: string, onCommit: (text: string) => void, opts?: { lang?: EditorLang }): void
  // Multiplayer presence: draw collaborators' carets (only cursors for the
  // cell currently open here — the caller filters; see main.ts).
  setRemoteCursors(cursors: RemoteCursor[]): void
}

export interface EditorController extends EditorAPI {
  title: Accessor<string>
  runLabel: Accessor<string>
  backVisible: Accessor<boolean>
  error: Accessor<string | null>
  // Initial toggle states + change handlers for the settings popover.
  initialVimMode: boolean
  initialMidiEnabled: boolean
  setVimMode(enabled: boolean): void
  setMidiEnabled(enabled: boolean): void
  resetHydra(): void
  back(): void
  // The CodeMirror DOM, for the view's editor-host div to adopt.
  cmDom: HTMLElement
}

export function createEditor(
  { onRun, getViews, onCaretView, getPlayIndex, vimMode = true, onVimModeChange, midiEnabled = false, onMidiEnabledChange, onResetHydra, onCursor, onEdit }: EditorOptions = {},
): EditorController {
  const [title, setTitle] = createSignal('DSL')
  const [runLabel, setRunLabel] = createSignal('Run')
  const [backVisible, setBackVisible] = createSignal(false)
  const [error, setErrorSig] = createSignal<string | null>(null)

  const setError = (msg: string | null): void => { setErrorSig(msg) }

  // When set, the editor is a window onto one table cell rather than the
  // program: Run commits the text back to the cell (an event append upstream).
  let cellTarget: { label: string; lang: EditorLang; onCommit: (text: string) => void } | null = null
  let stashedProgram = ''

  const cellLabel = (): string => cellTarget ? cellTarget.label : PROGRAM_CELL
  const cellLang = (): EditorLang => cellTarget ? cellTarget.lang : 'dsl'

  function run(): void {
    const text = view.state.doc.toString()
    if (cellTarget) cellTarget.onCommit(text)
    else onRun?.(text, { setError })
  }

  // Programmatic doc replacements (session scrub, remote code, cell targeting)
  // must not read as the user typing — the flag mutes onEdit for the dispatch
  // below (the update listener runs synchronously inside it).
  let programmaticDoc = false
  function setDoc(code: string): void {
    programmaticDoc = true
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } })
    } finally {
      programmaticDoc = false
    }
  }

  function exitCell(restoreProgram: boolean): void {
    if (!cellTarget) return
    cellTarget = null
    setTitle('DSL')
    setRunLabel('Run')
    setBackVisible(false)
    if (restoreProgram) setDoc(stashedProgram)
  }

  function editCell(label: string, code: string, onCommit: (text: string) => void, { lang = 'dsl' }: { lang?: EditorLang } = {}): void {
    if (!cellTarget) stashedProgram = view.state.doc.toString()
    cellTarget = { label, lang, onCommit }
    setTitle(label)
    setRunLabel('Apply')
    setBackVisible(true)
    setDoc(code)
    view.focus()
  }

  const vimCompartment = new Compartment()

  let lastCaretView: string | null = null

  const langService = getLangClient()

  // Created detached; <EditorPane>'s host div appends view.dom (CodeMirror
  // re-measures itself on attachment).
  const view = new EditorView({
    doc: defaultProgram,
    extensions: [
      vimCompartment.of(vimMode ? [vim()] : []),
      basicSetup,
      // The bare language (not javascript(), whose bundled keyword-snippet and
      // local-variable sources would duplicate what the language service
      // returns) — completion sources are registered explicitly below.
      new LanguageSupport(javascriptLanguage),
      javascriptLanguage.data.of({ autocomplete: viewNameCompletions(getViews, cellLang) }),
      javascriptLanguage.data.of({ autocomplete: codeCompletions(langService, makeInfoNode, makeSymbolCard, cellLang) }),
      ...(langService ? [typeHover(langService, makeSymbolCard, cellLang), signatureHelp(langService, makeSigCard, cellLang)] : []),
      EditorView.updateListener.of((u) => {
        if (!(u.selectionSet || u.docChanged)) return
        onCursor?.(cellLabel(), u.state.selection.main.head)
        if (u.docChanged && !programmaticDoc && onEdit) onEdit(cellLabel(), u.state.doc.toString())
        if (!onCaretView) return
        const name = viewAtPos(u.state.doc.toString(), u.state.selection.main.head)
        if (name && name !== lastCaretView) {
          lastCaretView = name
          onCaretView(name)
        }
      }),
      remoteCursorField,
      dslHover(getViews, getPlayIndex, buildTablePreview),
      oneDark,
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', run: () => { run(); return true } },
      ])),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ],
  })

  // External loads (session scrub, examples) always mean "show the program" —
  // leave any cell target without restoring its stash (the new code wins).
  function setCode(code: string): void {
    exitCell(false)
    setDoc(code)
  }

  return {
    run,
    getCode: () => view.state.doc.toString(),
    setCode,
    setError,
    editCell,
    title,
    runLabel,
    backVisible,
    error,
    initialVimMode: vimMode,
    initialMidiEnabled: midiEnabled,
    setVimMode(enabled: boolean): void {
      view.dispatch({ effects: vimCompartment.reconfigure(enabled ? [vim()] : []) })
      onVimModeChange?.(enabled)
    },
    setMidiEnabled(enabled: boolean): void {
      onMidiEnabledChange?.(enabled)
    },
    resetHydra(): void {
      onResetHydra?.()
    },
    back: () => exitCell(true),
    cmDom: view.dom,
    setRemoteCursors(cursors: RemoteCursor[]): void {
      view.dispatch({ effects: setRemoteCursorsEffect.of(cursors) })
    },
  }
}

// The editor pane. `children` slots the session selector/bar between the
// header and the CodeMirror host (app.tsx composes them there).
export function EditorPane(props: { ctl: EditorController; children?: JSX.Element }) {
  const { ctl } = props
  const [collapsed, setCollapsed] = createSignal(window.matchMedia('(max-width: 767px)').matches)
  // Settings: vim-mode and MIDI toggles. A small popover rather than plain
  // toggle buttons so more prefs can land here later without another header
  // slot. Positioned fixed (not absolute) so it isn't clipped by
  // #editor-pane's overflow:hidden when the panel is collapsed to header height.
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [menuPos, setMenuPos] = createSignal<{ top: number; right: number }>({ top: 0, right: 0 })
  let settingsWrap: HTMLDivElement | undefined
  let settingsBtn: HTMLButtonElement | undefined

  // A click anywhere outside the settings wrap closes the popover.
  listenGlobal(document, 'click', (e) => {
    if (settingsWrap && !settingsWrap.contains(e.target as Node)) setSettingsOpen(false)
  })

  return (
    <div id="editor-pane" classList={{ 'editor-collapsed': collapsed() }}>
      <div class="editor-header">
        <button
          class="collapse-btn"
          aria-label={collapsed() ? 'Expand code panel' : 'Collapse code panel'}
          onClick={() => setCollapsed(!collapsed())}
        >
          {collapsed() ? '▸' : '▾'}
        </button>
        <span class="editor-title">{ctl.title()}</span>
        <button
          class="editor-back-btn"
          title="Back to the program"
          style={{ display: ctl.backVisible() ? '' : 'none' }}
          onClick={() => ctl.back()}
        >
          Back
        </button>
        <button class="run-btn" onClick={() => ctl.run()}>{ctl.runLabel()}</button>
        <DocsPopover />
        <div class="settings-wrap" ref={settingsWrap}>
          <button
            class="settings-btn"
            title="Settings"
            aria-label="Settings"
            ref={settingsBtn}
            onClick={(e) => {
              e.stopPropagation()
              const opening = !settingsOpen()
              if (opening && settingsBtn) {
                const r = settingsBtn.getBoundingClientRect()
                setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
              }
              setSettingsOpen(opening)
            }}
          >
            ⚙
          </button>
          <div
            class="settings-menu"
            classList={{ open: settingsOpen() }}
            style={{ top: `${menuPos().top}px`, right: `${menuPos().right}px` }}
          >
            <label class="settings-row">
              <input
                type="checkbox"
                checked={ctl.initialVimMode}
                onChange={(e) => ctl.setVimMode(e.currentTarget.checked)}
              />
              Vim mode
            </label>
            <label class="settings-row">
              <input
                type="checkbox"
                checked={ctl.initialMidiEnabled}
                onChange={(e) => ctl.setMidiEnabled(e.currentTarget.checked)}
              />
              MIDI
            </label>
            <button
              class="settings-row settings-action"
              title="Fixes hydra visuals stuck in an error state (same fix as resizing the window)"
              onClick={() => { ctl.resetHydra(); setSettingsOpen(false) }}
            >
              Reset visuals
            </button>
          </div>
        </div>
      </div>
      {props.children}
      <div class="editor-host" ref={(el) => el.appendChild(ctl.cmDom)} />
      <Show when={ctl.error()}>
        <div class="editor-error" style={{ display: 'block' }}>{ctl.error()}</div>
      </Show>
    </div>
  )
}
