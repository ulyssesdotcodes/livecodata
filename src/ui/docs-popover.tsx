// Info popover (the ℹ button): the DSL function reference — reusing the doc
// dictionaries that drive editor autocomplete, so it never drifts from what
// completion shows — plus a plain-language guide to the system's tables.
// Unlike other panes it owns its own open/close state; nothing worth hoisting
// into main.ts.

import { createSignal, For, Show } from 'solid-js'
import { listenGlobal } from './dom.js'
import {
  DSL_BUILTIN_DOCS, TABLE_METHOD_DOCS, EXPR_METHOD_DOCS, THREE_METHOD_DOCS,
  type DocEntry,
} from '../editor-support.js'

interface FnSection {
  title: string
  blurb: string
  docs: Record<string, DocEntry>
}

const FN_SECTIONS: FnSection[] = [
  {
    title: 'Builders',
    blurb: 'Top-level functions that make a Table to start a chain from.',
    docs: DSL_BUILTIN_DOCS,
  },
  {
    title: 'Table methods',
    blurb: 'Chain off any Table. Each returns a new Table, so they compose.',
    docs: TABLE_METHOD_DOCS,
  },
  {
    title: 'Expression methods',
    blurb: 'Chain off field() / lit() / idx() to build a diffable expression.',
    docs: EXPR_METHOD_DOCS,
  },
  {
    title: '.three animators',
    blurb: 'Chain off a scene table\'s .three accessor to animate objects over beats.',
    docs: THREE_METHOD_DOCS,
  },
]

interface TableDoc {
  name: string
  detail: string
  info: string
}

const TABLE_DOCS: TableDoc[] = [
  {
    name: 'Table',
    detail: 'the one data type',
    info: 'Everything is a Table — an array of plain row objects, built and transformed by the DSL. Timing lives in each row\'s `beat` column (1-indexed); there are no seconds in the data model.',
  },
  {
    name: 'Views',
    detail: 'computed tables',
    info: 'Named tables you register with define("name", (rand, table) => …) or .save("name"). Cooked lazily and only when something changed, each becomes a tab in the table panel. Reference another view with table("name") to build a dependency.',
  },
  {
    name: 'Editable tables',
    detail: 'hand-entered data',
    info: 'editable("name", schema, seedRows) makes a table whose rows you type in the panel instead of computing. Every edit is an appended event and the visible table is the fold of those events, so edits persist across runs. Its edit history shows under the "Events" sub-tab (the "name·events" view).',
  },
  {
    name: 'code',
    detail: 'the program itself',
    info: 'The program you\'re editing is itself an editable table (schema { code, seed }). Its change history is "code·events" — which is what a saved session serializes.',
  },
  {
    name: 'midi / midi·events',
    detail: 'live MIDI input',
    info: 'With MIDI enabled (⚙ settings), incoming notes stream into the "midi·events" log; the folded "midi" table holds, per note, the latest loop\'s take. midi("c4") bindings resolve against it each frame, so notes you play while looping replay at the loop position they were heard.',
  },
  {
    name: 'sliders / slider',
    detail: 'on-screen controls',
    info: 'Define a view named "sliders" of rows { id, min, max, default? } to draw labelled sliders over the visual. Dragging one records automation as "slider" events; slider("id") resolves against the folded "slider" table (raw log: "slider·events"), exactly like MIDI.',
  },
  {
    name: 'taps',
    detail: 'the tempo source',
    info: 'taps() is the tap-beat table — one row per Tap button press ({ beat, time }, time an absolute epoch ms). It is the source of tempo: the playhead runs at the tapped rate, and tempo() / beats() read from it.',
  },
  {
    name: 'Scene rows',
    detail: 'what drives the 3D view',
    info: 'Rows rendered as 3D objects share a schema: type ("create" | "update"), id, beat, shape, position px/py/pz, rotation rx/ry/rz, scale sx/sy/sz, color. rasterize(maxBeats) bakes sparse beat-keyed event rows into a dense per-frame world state, easing numeric fields between keyframes.',
  },
]

export function DocsPopover() {
  const [open, setOpen] = createSignal(false)
  let wrap: HTMLDivElement | undefined
  let btn: HTMLButtonElement | undefined
  const [pos, setPos] = createSignal<{ top: number; right: number }>({ top: 0, right: 0 })

  listenGlobal(document, 'click', (e) => {
    if (wrap && !wrap.contains(e.target as Node)) setOpen(false)
  })
  listenGlobal(window, 'keydown', (e) => {
    if (e.key === 'Escape') setOpen(false)
  })

  return (
    <div class="settings-wrap docs-wrap" ref={wrap}>
      <button
        class="settings-btn docs-btn"
        title="DSL reference & tables"
        aria-label="DSL reference and tables help"
        ref={btn}
        onClick={(e) => {
          e.stopPropagation()
          const opening = !open()
          if (opening && btn) {
            const r = btn.getBoundingClientRect()
            setPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
          }
          setOpen(opening)
        }}
      >
        ℹ
      </button>
      <Show when={open()}>
        <div
          class="docs-popover"
          style={{ top: `${pos().top}px`, right: `${pos().right}px` }}
        >
          <div class="docs-popover-head">
            <span class="docs-popover-title">Reference</span>
            <button class="docs-close" aria-label="Close" onClick={() => setOpen(false)}>×</button>
          </div>
          <div class="docs-popover-body">
            <section class="docs-section">
              <h3 class="docs-h">Tables the system uses</h3>
              <p class="docs-blurb">
                Every value is a Table — rows keyed by <code>beat</code>. These
                are the tables you'll meet as tabs in the panel below.
              </p>
              <dl class="docs-list">
                <For each={TABLE_DOCS}>
                  {(t) => (
                    <>
                      <dt class="docs-term">
                        <code>{t.name}</code>
                        <span class="docs-detail">{t.detail}</span>
                      </dt>
                      <dd class="docs-def">{t.info}</dd>
                    </>
                  )}
                </For>
              </dl>
            </section>

            <section class="docs-section">
              <h3 class="docs-h">DSL functions</h3>
              <For each={FN_SECTIONS}>
                {(sec) => (
                  <div class="docs-fn-group">
                    <h4 class="docs-h4">{sec.title}</h4>
                    <p class="docs-blurb">{sec.blurb}</p>
                    <dl class="docs-list">
                      <For each={Object.keys(sec.docs)}>
                        {(key) => (
                          <>
                            <dt class="docs-term">
                              <code>{sec.docs[key].sig}</code>
                              <span class="docs-detail">{sec.docs[key].detail}</span>
                            </dt>
                            <dd class="docs-def">{sec.docs[key].info}</dd>
                          </>
                        )}
                      </For>
                    </dl>
                  </div>
                )}
              </For>
            </section>
          </div>
        </div>
      </Show>
    </div>
  )
}
