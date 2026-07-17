// Solid-flavored DOM helpers for the places a view legitimately steps outside
// JSX (global listeners, detached nodes handed to non-Solid APIs, focusing
// just-mounted inputs), kept tied to the owning component's lifecycle.

import { onCleanup } from 'solid-js'
import { render } from 'solid-js/web'
import type { JSX } from 'solid-js'

// Attach a document/window listener now; detach when the owning component is
// disposed.
export function listenGlobal<K extends keyof GlobalEventHandlersEventMap>(
  target: Document | Window,
  type: K,
  handler: (e: GlobalEventHandlersEventMap[K]) => void,
): void {
  target.addEventListener(type, handler as EventListener)
  onCleanup(() => target.removeEventListener(type, handler as EventListener))
}

// Render a single-root component into a detached holder and return the root,
// for hosts that insert the element themselves (e.g. CodeMirror tooltips).
export function mountComponent(fn: () => JSX.Element): { el: HTMLElement; dispose: () => void } {
  const holder = document.createElement('div')
  const dispose = render(fn, holder)
  return { el: holder.firstElementChild as HTMLElement, dispose }
}

// Refs fire before the element is in the document, so defer focus a microtask.
export function focusInput(el: HTMLInputElement, select = true): void {
  queueMicrotask(() => {
    el.focus()
    if (select) el.select()
  })
}
