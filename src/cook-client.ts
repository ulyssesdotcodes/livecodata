// Cook client — the main-thread handle on the cook worker.
// ----------------------------------------------------------------------------
// Wraps the Worker in a promise-per-request API and unpacks the transferred
// result back into real Tables (see cook-transfer.ts). Takes anything
// Worker-shaped so tests can drive it with a fake message channel.

import { unpackCooked } from './cook-transfer.js'
import type { CookRequest, CookResponse, DeclaredEditable } from './cook-service.js'
import type { CookedResult } from './replay.js'
import type { Row } from './lineage.js'

export interface WorkerLike {
  postMessage(msg: unknown): void
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void
}

export interface CookInput {
  code: string
  seed: number
  dataCache: Map<string, string>
  tapRows: Row[]
  editables: Array<{ name: string; rows: Row[] }>
  // Seed rows for tables the store hasn't seen yet, keyed by table name — see
  // CookRequest.seeds. Set when opening an example whose editable table data
  // lives with the sample rather than inline in the program.
  seeds?: Record<string, Row[]>
}

export interface CookOutcome {
  cooked: CookedResult
  declared: DeclaredEditable[]
}

export interface CookClient {
  cook(input: CookInput): Promise<CookOutcome>
}

export function createCookClient(worker: WorkerLike): CookClient {
  let nextId = 1
  const pending = new Map<number, { resolve: (o: CookOutcome) => void; reject: (e: Error) => void }>()

  worker.addEventListener('message', (e) => {
    const resp = e.data as CookResponse
    const p = pending.get(resp.id)
    if (!p) return
    pending.delete(resp.id)
    if (resp.ok) p.resolve({ cooked: unpackCooked(resp.cooked), declared: resp.declared })
    else p.reject(new Error(resp.error))
  })

  return {
    cook(input: CookInput): Promise<CookOutcome> {
      const req: CookRequest = {
        id: nextId++,
        code: input.code,
        seed: input.seed,
        dataCache: [...input.dataCache],
        tapRows: input.tapRows,
        editables: input.editables,
        ...(input.seeds !== undefined ? { seeds: input.seeds } : {}),
      }
      return new Promise((resolve, reject) => {
        pending.set(req.id, { resolve, reject })
        worker.postMessage(req)
      })
    },
  }
}
