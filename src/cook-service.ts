// Cook service — the worker side of off-main-thread cooking, minus the Worker.
// ----------------------------------------------------------------------------
// Everything expensive about running a program — DSL evaluation, materialize,
// physics baking, origami compilation, rasterize — happens in handle(), which
// is a pure request → response function so node tests can drive it directly;
// cook-worker.ts is the humble shell that wires it to postMessage. The one
// long-lived piece is the runtime itself: keeping it across requests is what
// preserves the 2-generation materialize memo (an edit that leaves the physics
// subgraph untouched still skips re-baking it, same as before the worker).
//
// The store stays on the main thread (the UI folds and reads it
// synchronously, and persistence needs localStorage), so a request carries a
// rows snapshot of every editable table plus the tap rows. editable() calls
// during the cook behave exactly like ensure()'s read-only replay branch —
// serve the snapshot, or the conformed seed rows for a table the store hasn't
// seen — and are reported back as `declared`, which the main thread feeds to
// the real ensure() (appending create/declare-schema events, which then ride
// persistence and multiplayer exactly as they always did).

import { createRuntime } from './runtime.js'
import { cookProgram } from './replay.js'
import { conformRow, schemaColumns, type ColumnType } from './editable-tables.js'
import { packCooked, type PackedCook } from './cook-transfer.js'
import type { PhysicsEngine } from './dsl.js'
import type { Row } from './lineage.js'

export interface CookRequest {
  id: number
  code: string
  seed: number
  dataCache: Array<[string, string]>
  tapRows: Row[]
  // Current rows of every editable table, folded through any active replay
  // view — i.e. exactly what ensure() would serve on the main thread.
  editables: Array<{ name: string; rows: Row[] }>
}

// An editable() the program declared during the cook; the main thread applies
// these through the store's real ensure().
export interface DeclaredEditable {
  name: string
  schema: Record<string, ColumnType>
  seedRows?: Row[]
}

export type CookResponse =
  | { id: number; ok: true; cooked: PackedCook; declared: DeclaredEditable[] }
  | { id: number; ok: false; error: string }

export interface CookService {
  handle(req: CookRequest): CookResponse
}

export function createCookService({ physics }: { physics?: () => PhysicsEngine | null } = {}): CookService {
  let snapshot = new Map<string, Row[]>()
  let taps: Row[] = []
  let declared: DeclaredEditable[] = []

  const runtime = createRuntime({
    physics: physics ?? (() => null),
    tapRows: () => taps,
    editableRows: (name, schema, seedRows) => {
      declared.push({ name, schema, ...(seedRows !== undefined ? { seedRows } : {}) })
      const existing = snapshot.get(name)
      if (existing) return existing
      return (seedRows ?? []).map((r) => conformRow(r, schemaColumns(schema)))
    },
  })

  return {
    handle(req: CookRequest): CookResponse {
      snapshot = new Map(req.editables.map((e) => [e.name, e.rows]))
      taps = req.tapRows
      declared = []
      try {
        const cooked = cookProgram(runtime, req.code, req.seed, new Map(req.dataCache))
        return { id: req.id, ok: true, cooked: packCooked(cooked), declared }
      } catch (err) {
        return { id: req.id, ok: false, error: (err as Error).message }
      }
    },
  }
}
