// Number-literal scrubbing: drag any numeric literal horizontally to change
// it in place — in the program, post/hydra cells, and "=" expression cells
// alike. Edits touch only the document buffer, exactly like typing the digits;
// Apply/Run stays the one sync point, and the canvas never follows an
// unapplied buffer. Mouse drags engage directly on the literal (a clean click
// still places the caret); touch gets pan-y arbitration — vertical swipes
// scroll, horizontal drags on a literal scrub.

import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { scrubText } from '../num-scrub.js'

const mark = Decoration.mark({ class: 'cm-scrub-num' })

function buildMarks(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (n) => { if (n.name === 'Number') b.add(n.from, n.to, mark) },
    })
  }
  return b.finish()
}

const numberMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = buildMarks(view) }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
      this.decorations = buildMarks(u.view)
    }
  }
}, { decorations: (v) => v.decorations })

interface Gesture {
  pointerId: number
  startX: number
  startY: number
  from: number
  to: number
  original: string
  touch: boolean
  started: boolean
  caretPos: number
}

// The literal's range at pos, sign included when an adjacent '-' reads as
// unary (nothing value-like right before it).
function literalAt(view: EditorView, pos: number): { from: number; to: number } | null {
  let node = syntaxTree(view.state).resolveInner(pos, -1)
  if (node.name !== 'Number') node = syntaxTree(view.state).resolveInner(pos, 1)
  if (node.name !== 'Number') return null
  let { from } = node
  if (from > 0 && view.state.doc.sliceString(from - 1, from) === '-') {
    const before = from >= 2 ? view.state.doc.sliceString(from - 2, from - 1) : ''
    if (!/[\w)\]"'`.]/.test(before)) from--
  }
  return { from, to: node.to }
}

function scrubHandlers(): Extension {
  let g: Gesture | null = null

  const apply = (view: EditorView, e: PointerEvent): void => {
    if (!g) return
    const text = scrubText(g.original, e.clientX - g.startX, e.clientY - g.startY)
    if (text === view.state.doc.sliceString(g.from, g.to)) return
    view.dispatch({
      changes: { from: g.from, to: g.to, insert: text },
      selection: { anchor: g.from + text.length },
      userEvent: 'input.scrub',
      scrollIntoView: false,
    })
    g.to = g.from + text.length
  }

  return EditorView.domEventHandlers({
    pointerdown: (e, view) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return false
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (pos == null) return false
      const lit = literalAt(view, pos)
      if (!lit) return false
      const touch = e.pointerType === 'touch'
      g = {
        pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
        ...lit, original: view.state.doc.sliceString(lit.from, lit.to),
        touch, started: false, caretPos: pos,
      }
      if (!touch) {
        // Suppress CodeMirror's own mousedown (selection drag) — a clean
        // click places the caret ourselves on pointerup.
        e.preventDefault()
        view.contentDOM.setPointerCapture(e.pointerId)
        return true
      }
      return false
    },
    pointermove: (e, view) => {
      if (!g || e.pointerId !== g.pointerId) return false
      const dx = Math.abs(e.clientX - g.startX)
      const dy = Math.abs(e.clientY - g.startY)
      if (!g.started) {
        if (g.touch) {
          // pan-y touch-action lets vertical swipes scroll natively; a mostly
          // vertical move means the user is scrolling — let go.
          if (dy > 8 && dy > dx) { g = null; return false }
          if (!(dx > 6 && dx > dy)) return false
          view.contentDOM.setPointerCapture(e.pointerId)
        } else if (dx <= 4) {
          return false
        }
        g.started = true
      }
      e.preventDefault()
      apply(view, e)
      return true
    },
    pointerup: (e, view) => {
      if (!g || e.pointerId !== g.pointerId) return false
      const wasStarted = g.started
      const wasTouch = g.touch
      const caret = g.caretPos
      g = null
      if (!wasStarted && !wasTouch) {
        view.dispatch({ selection: { anchor: caret } })
        view.focus()
        return true
      }
      return wasStarted
    },
    pointercancel: () => {
      g = null
      return false
    },
  })
}

export function numberScrub(): Extension {
  return [numberMarks, scrubHandlers()]
}
