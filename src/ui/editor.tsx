// Code editor pane. The chrome (header, Run/Back buttons, settings popover,
// error strip) is a humble SolidJS component; CodeMirror manages its own DOM
// inside the host div it is handed. All editor *logic* — completion/hover
// sources, docs, cell-target bookkeeping — lives in ../editor-support.ts and
// this file's controller closure; the component only renders state and
// forwards clicks.

import { render } from 'solid-js/web'
import { createSignal, createEffect, Show, type Accessor } from 'solid-js'
import { listenGlobal, mountComponent } from './dom.js'
import { EditorView, basicSetup } from 'codemirror'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap } from '@codemirror/view'
import { Prec, Compartment } from '@codemirror/state'
import { vim } from '@replit/codemirror-vim'
import { dslCompletions, dslHover, viewAtPos, defaultProgram } from '../editor-support.js'
import { buildTablePreview } from './table-preview.js'
import type { Table } from '../dsl.js'

export { defaultProgram }

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
  // Extra bars slotted between the header and the code host — main.ts places
  // the session selector and session bar here (they belong to the session
  // subsystem, not the editor, so they arrive as ready-made elements).
  subHeader?: HTMLElement[]
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

interface ChromeProps {
  parent: HTMLElement
  title: Accessor<string>
  runLabel: Accessor<string>
  backVisible: Accessor<boolean>
  error: Accessor<string | null>
  vimMode: boolean
  midiEnabled: boolean
  onRun: () => void
  onBack: () => void
  onVimChange: (enabled: boolean) => void
  onMidiChange: (enabled: boolean) => void
  hostRef: (el: HTMLDivElement) => void
  subHeader?: HTMLElement[]
}

function EditorChrome(props: ChromeProps) {
  const [collapsed, setCollapsed] = createSignal(window.matchMedia('(max-width: 767px)').matches)
  // Settings: vim-mode and MIDI toggles. A small popover rather than plain
  // toggle buttons so more prefs can land here later without another header
  // slot. Positioned fixed (not absolute) so it isn't clipped by
  // #editor-pane's overflow:hidden when the panel is collapsed to header height.
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [menuPos, setMenuPos] = createSignal<{ top: number; right: number }>({ top: 0, right: 0 })
  let settingsWrap: HTMLDivElement | undefined
  let settingsBtn: HTMLButtonElement | undefined

  // The collapsed class lives on the pane container (which also holds the
  // CodeMirror host), not on this component's own nodes.
  createEffect(() => props.parent.classList.toggle('editor-collapsed', collapsed()))

  // A click anywhere outside the settings wrap closes the popover.
  listenGlobal(document, 'click', (e) => {
    if (settingsWrap && !settingsWrap.contains(e.target as Node)) setSettingsOpen(false)
  })

  return (
    <>
      <div class="editor-header">
        <button
          class="collapse-btn"
          aria-label={collapsed() ? 'Expand code panel' : 'Collapse code panel'}
          onClick={() => setCollapsed(!collapsed())}
        >
          {collapsed() ? '▸' : '▾'}
        </button>
        <span class="editor-title">{props.title()}</span>
        <button
          class="editor-back-btn"
          title="Back to the program"
          style={{ display: props.backVisible() ? '' : 'none' }}
          onClick={props.onBack}
        >
          Back
        </button>
        <button class="run-btn" onClick={props.onRun}>{props.runLabel()}</button>
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
                checked={props.vimMode}
                onChange={(e) => props.onVimChange(e.currentTarget.checked)}
              />
              Vim mode
            </label>
            <label class="settings-row">
              <input
                type="checkbox"
                checked={props.midiEnabled}
                onChange={(e) => props.onMidiChange(e.currentTarget.checked)}
              />
              MIDI
            </label>
          </div>
        </div>
      </div>
      {props.subHeader}
      <div class="editor-host" ref={props.hostRef} />
      <Show when={props.error()}>
        <div class="editor-error" style={{ display: 'block' }}>{props.error()}</div>
      </Show>
    </>
  )
}

export function initEditor(
  parent: HTMLElement,
  { onRun, getViews, onCaretView, getPlayIndex, vimMode = true, onVimModeChange, midiEnabled = false, onMidiEnabledChange, subHeader }: EditorOptions = {},
): EditorAPI {
  const [title, setTitle] = createSignal('DSL')
  const [runLabel, setRunLabel] = createSignal('Run')
  const [backVisible, setBackVisible] = createSignal(false)
  const [error, setErrorSig] = createSignal<string | null>(null)

  const setError = (msg: string | null): void => { setErrorSig(msg) }

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
    setTitle('DSL')
    setRunLabel('Run')
    setBackVisible(false)
    if (restoreProgram) setDoc(stashedProgram)
  }

  function editCell(label: string, code: string, onCommit: (text: string) => void): void {
    if (!cellTarget) stashedProgram = view.state.doc.toString()
    cellTarget = { label, onCommit }
    setTitle(label)
    setRunLabel('Apply')
    setBackVisible(true)
    setDoc(code)
    view.focus()
  }

  const vimCompartment = new Compartment()

  let host: HTMLDivElement | undefined
  render(
    () => (
      <EditorChrome
        parent={parent}
        title={title}
        runLabel={runLabel}
        backVisible={backVisible}
        error={error}
        vimMode={vimMode}
        midiEnabled={midiEnabled}
        onRun={run}
        onBack={() => exitCell(true)}
        onVimChange={(enabled) => {
          view.dispatch({ effects: vimCompartment.reconfigure(enabled ? [vim()] : []) })
          onVimModeChange?.(enabled)
        }}
        onMidiChange={(enabled) => onMidiEnabledChange?.(enabled)}
        hostRef={(el) => { host = el }}
        subHeader={subHeader}
      />
    ),
    parent,
  )

  let lastCaretView: string | null = null

  const view = new EditorView({
    doc: defaultProgram,
    extensions: [
      vimCompartment.of(vimMode ? [vim()] : []),
      basicSetup,
      javascript(),
      javascriptLanguage.data.of({ autocomplete: dslCompletions(getViews, makeInfoNode) }),
      EditorView.updateListener.of((u) => {
        if (!onCaretView || !(u.selectionSet || u.docChanged)) return
        const name = viewAtPos(u.state.doc.toString(), u.state.selection.main.head)
        if (name && name !== lastCaretView) {
          lastCaretView = name
          onCaretView(name)
        }
      }),
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
    parent: host!,
  })

  // External loads (session scrub, examples) always mean "show the program" —
  // leave any cell target without restoring its stash (the new code wins).
  function setCode(code: string): void {
    exitCell(false)
    setDoc(code)
  }

  return { run, getCode: () => view.state.doc.toString(), setCode, setError, editCell }
}
