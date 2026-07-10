// Small Solid-flavored DOM helpers shared by the ui components: the few
// places where a view legitimately has to step outside JSX (document/window
// listeners, hosts that hand a detached node to a non-Solid API like
// CodeMirror, focusing a just-mounted input) are funneled through here so
// they stay tied to the owning component's lifecycle.

import { onCleanup } from 'solid-js'
import { render } from 'solid-js/web'
import type { JSX } from 'solid-js'

// A document/window event listener scoped to the current component: attached
// now, detached when the component is disposed. The Solid equivalent of the
// classic addEventListener/removeEventListener pair for targets that live
// outside the component's own JSX.
export function listenGlobal<K extends keyof GlobalEventHandlersEventMap>(
  target: Document | Window,
  type: K,
  handler: (e: GlobalEventHandlersEventMap[K]) => void,
): void {
  target.addEventListener(type, handler as EventListener)
  onCleanup(() => target.removeEventListener(type, handler as EventListener))
}

// Render a component with a single root element into a detached holder and
// hand back that root. For views whose element is inserted by someone else —
// main.ts composing the panes, CodeMirror adopting a tooltip — where there is
// no pre-existing container to render into.
export function mountComponent(fn: () => JSX.Element): { el: HTMLElement; dispose: () => void } {
  const holder = document.createElement('div')
  const dispose = render(fn, holder)
  return { el: holder.firstElementChild as HTMLElement, dispose }
}

// Focus (and optionally select) an inline editor input once it's attached to
// the document — refs fire before insertion, so defer a microtask.
export function focusInput(el: HTMLInputElement, select = true): void {
  queueMicrotask(() => {
    el.focus()
    if (select) el.select()
  })
}
