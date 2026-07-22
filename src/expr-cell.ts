// "=" expression cells: a cell whose string value starts with "=" holds a JS
// expression over the expr scope — "=slider('h').mul(2)" — evaluated by the
// cook per row to exactly what derive() produces: a number, or a streaming
// { $expr } binding playback resolves per frame. The text is the persisted
// format; bindings stay cook-local artifacts. Shared by the worker runtime
// (runtime.ts evaluates cells while serving editable() rows) and the main
// thread (cell validity in the table panel), so both sides agree on what a
// cell means. Compilation is memoized by text; evaluation runs per call so a
// cell's slider() declaration fires on every cook (the cook service resets
// its declaration set per run).

import {
  Expr, EXPR_FNS, bakeExpr, callExpr, evalExpr, isStreamingNode, makeExprNamespace,
  type EvalCtx, type ExprNamespace,
} from './dsl.js'
import {
  isExprCellText, registerExprCellCheck, schemaColumns,
  type ExprCellCheck, type Schema,
} from './editable-tables.js'
import { registerExprArgSupport } from './post-lang.js'
import type { Row } from './lineage.js'

export { isExprCellText }

const plainNs = makeExprNamespace(null)

// The compiled functions' parameter list: every EXPR_FNS name as a bare
// wrapper (sin(x) ≡ x.sin()), then the sources/constants and the expr
// namespace itself. Order is the call convention — append only.
const FN_NAMES = Object.keys(EXPR_FNS)
const SOURCE_NAMES = ['field', 'lit', 'idx', 'midi', 'slider', 'time', 'progress', 'pi', 'tau', 'e', 'expr']
const SCOPE_NAMES = [...FN_NAMES, ...SOURCE_NAMES]

const scopeCache = new WeakMap<ExprNamespace, unknown[]>()
function scopeValues(ns: ExprNamespace): unknown[] {
  const hit = scopeCache.get(ns)
  if (hit) return hit
  const values: unknown[] = FN_NAMES.map((name) => (...args: (Expr | number)[]) => callExpr(name, args))
  values.push(ns.field, ns.lit, ns.idx, ns.midi, ns.slider, ns.time, ns.progress, ns.pi, ns.tau, ns.e, ns)
  scopeCache.set(ns, values)
  return values
}

// null = the text doesn't compile. Strict mode so a stray assignment to an
// unknown name throws (→ invalid) instead of leaking a global.
const compiled = new Map<string, ((...args: unknown[]) => unknown) | null>()
function compile(text: string): ((...args: unknown[]) => unknown) | null {
  const hit = compiled.get(text)
  if (hit !== undefined) return hit
  let fn: ((...args: unknown[]) => unknown) | null = null
  try {
    fn = new Function(...SCOPE_NAMES, `"use strict"; return (${text.slice(1)});`) as (...args: unknown[]) => unknown
  } catch {
    fn = null
  }
  compiled.set(text, fn)
  return fn
}

export interface ExprCellResult {
  ok: boolean
  value: unknown
  streaming: boolean
}

const INVALID: ExprCellResult = { ok: false, value: undefined, streaming: false }

/**
 * Evaluate one "=" cell against its row. An Expr result bakes with exactly
 * derive()'s semantics — streaming → { $expr } binding, constant → its
 * evaluated value (required to be a finite number here); a plain number
 * passes through; anything else, or a throw, is invalid — the cook then uses
 * the column default, the "broken post cell declares nothing" precedent.
 */
export function evalExprCell(text: string, row: Row, i: number, ns: ExprNamespace = plainNs): ExprCellResult {
  const fn = compile(text)
  if (!fn) return INVALID
  let out: unknown
  try {
    out = fn(...scopeValues(ns))
  } catch {
    return INVALID
  }
  if (out instanceof Expr) {
    if (isStreamingNode(out.node)) return { ok: true, value: { $expr: out.node }, streaming: true }
    const v = bakeExpr(out.node, row, i)
    return typeof v === 'number' && Number.isFinite(v) ? { ok: true, value: v, streaming: false } : INVALID
  }
  return typeof out === 'number' && Number.isFinite(out) ? { ok: true, value: out, streaming: false } : INVALID
}

// Row-free validity for cellValid: does the text evaluate to an Expr or a
// number at all, and is the result streaming? Constant exprs are not baked
// (no row here), so a field() read can't false-flag as NaN. Memoized by text;
// the scope never declares (plainNs), so the panel's checks stay side-effect
// free.
const checks = new Map<string, ExprCellCheck>()
export function checkExprCell(text: string): ExprCellCheck {
  const hit = checks.get(text)
  if (hit) return hit
  let res: ExprCellCheck = { valid: false, streaming: false }
  const fn = compile(text)
  if (fn) {
    try {
      const out = fn(...scopeValues(plainNs))
      if (out instanceof Expr) res = { valid: true, streaming: isStreamingNode(out.node) }
      else if (typeof out === 'number' && Number.isFinite(out)) res = { valid: true, streaming: false }
    } catch { /* invalid */ }
  }
  checks.set(text, res)
  return res
}

registerExprCellCheck(checkExprCell)

// Post live args: an Expr resolves per frame against the props object — the
// folded vars are the row (so field() reads sibling variables), sliders and
// the clock map to their EvalCtx sources, and midi rides the $midi sampler
// the visualizer injects.
registerExprArgSupport({
  isExpr: (v) => v instanceof Expr,
  toLiveFn: (v) => {
    const node = (v as Expr).node
    return (p) => {
      const ctx: EvalCtx = {
        slider: (id) => {
          const s = (p.sliders as Record<string, number> | undefined)?.[id]
          return typeof s === 'number' ? s : 0
        },
        time: () => (typeof p.time === 'number' ? p.time : 0),
        ...(typeof p.$midi === 'function' ? { midi: p.$midi as EvalCtx['midi'] } : {}),
      }
      const n = Number(evalExpr(node, p as Row, 0, ctx))
      return Number.isFinite(n) ? n : 0
    }
  },
  makeScope: (defineSlider) => makeExprNamespace({ defineSlider }),
})

/**
 * Evaluate every "=" cell in the rows' schema-declared number columns (the
 * columns the "=" relaxation applies to — see cellValid) against its own row.
 * Never mutates the input rows: on the main thread they are the store's live
 * objects. A broken cell gets the number column default, 0.
 */
export function evalRowExprCells(rows: Row[], schema: Schema, ns: ExprNamespace = plainNs): Row[] {
  const numCols = schemaColumns(schema).filter((c) => c.type === 'number').map((c) => c.name)
  if (!numCols.length) return rows
  return rows.map((row, i) => {
    let out: Row | null = null
    for (const name of numCols) {
      const v = row[name]
      if (!isExprCellText(v)) continue
      const res = evalExprCell(v, row, i, ns)
      out ??= { ...row }
      out[name] = res.ok ? res.value : 0
    }
    return out ?? row
  })
}
