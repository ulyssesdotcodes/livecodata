// Lang client — the main-thread handle on the language-service worker.
// ----------------------------------------------------------------------------
// Promise-per-request over the worker, with a readiness state the editor's
// completion/hover sources consult: until the worker reports ready (or if it
// ever fails — worker construction blocked, env fetch failed), sources fall
// back to the heuristic completions in editor-support.ts, so the editor is
// never worse than it was without the service. Takes anything Worker-shaped
// so tests can drive it with a fake message channel (see cook-client.ts).

import type { LangRequest, LangResponse, LangReady } from './lang-worker.js'
import type { LangCompletions, LangSymbolInfo, LangSignatureHelp, EditorLang } from './lang-service.js'

export interface LangWorkerLike {
  postMessage(msg: unknown): void
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void
  addEventListener(type: 'error', cb: () => void): void
}

export type LangStatus = 'loading' | 'ready' | 'failed'

// Omit that distributes over a union (plain Omit collapses LangRequest's
// variants to their common keys).
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

// Every query names the language surface it runs against (default 'dsl');
// hydra sketch cells pass 'hydra'.
export interface LangClient {
  status(): LangStatus
  completions(text: string, pos: number, lang?: EditorLang): Promise<LangCompletions | null>
  details(text: string, pos: number, name: string, lang?: EditorLang): Promise<LangSymbolInfo | null>
  quickInfo(text: string, pos: number, lang?: EditorLang): Promise<LangSymbolInfo | null>
  signatureHelp(text: string, pos: number, triggerChar?: string, lang?: EditorLang): Promise<LangSignatureHelp | null>
}

export function createLangClient(worker: LangWorkerLike): LangClient {
  let nextId = 1
  let status: LangStatus = 'loading'
  const pending = new Map<number, (result: unknown) => void>()

  // The worker script failing outright (404 in a broken deploy, blocked by
  // CSP) fires 'error' and nothing else — flush everything so callers fall
  // back instead of hanging.
  worker.addEventListener('error', () => {
    status = 'failed'
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
  })

  worker.addEventListener('message', (e) => {
    const msg = e.data as LangResponse | LangReady
    if ('kind' in msg) {
      status = msg.kind === 'ready' ? 'ready' : 'failed'
      return
    }
    const resolve = pending.get(msg.id)
    if (!resolve) return
    pending.delete(msg.id)
    // A per-query error (worker caught an exception) resolves null rather than
    // rejecting: callers treat null as "no answer" and fall back.
    resolve(msg.ok ? msg.result : null)
  })

  function ask<T>(req: DistributedOmit<LangRequest, 'id'>): Promise<T | null> {
    if (status === 'failed') return Promise.resolve(null)
    const id = nextId++
    return new Promise((resolve) => {
      pending.set(id, (result) => resolve(result as T | null))
      worker.postMessage({ ...req, id })
    })
  }

  return {
    status: () => status,
    completions: (text, pos, lang) => ask<LangCompletions>({ kind: 'completions', text, pos, lang }),
    details: (text, pos, name, lang) => ask<LangSymbolInfo>({ kind: 'details', text, pos, name, lang }),
    quickInfo: (text, pos, lang) => ask<LangSymbolInfo>({ kind: 'quickinfo', text, pos, lang }),
    signatureHelp: (text, pos, triggerChar, lang) => ask<LangSignatureHelp>(
      triggerChar !== undefined ? { kind: 'signature', text, pos, triggerChar, lang } : { kind: 'signature', text, pos, lang },
    ),
  }
}
