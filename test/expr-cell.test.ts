// "=" expression cells (src/expr-cell.ts): text in, exactly derive()'s output
// — a number for constants, a { $expr } binding for streaming — evaluated by
// the cook per row, with slider declarations flowing through the runtime.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evalExprCell, checkExprCell, evalRowExprCells } from '../src/expr-cell.js'
import { createCookService, type CookResponse } from '../src/cook-service.js'
import { isBinding, evalExpr, type Binding } from '../src/dsl.js'
import type { Row } from '../src/lineage.js'

const resolve = (v: unknown, sliderValue: number): unknown =>
  evalExpr((v as Binding).$expr, {}, 0, { slider: () => sliderValue })

test('"=" text: streaming exprs bake to bindings, constants to numbers', () => {
  const s = evalExprCell("=slider('h').mul(2)", {}, 0)
  assert.equal(s.ok, true)
  assert.equal(s.streaming, true)
  assert.ok(isBinding(s.value))
  assert.equal(resolve(s.value, 3), 6, 'the binding resolves per frame like any derive() binding')

  const c = evalExprCell('=lit(2).mul(3).add(field("beat"))', { beat: 4 }, 0)
  assert.deepEqual(c, { ok: true, value: 10, streaming: false })

  assert.equal(evalExprCell('=sin(pi.div(2)).mul(4)', {}, 0).value, 4, 'bare registry fns and constants are in scope')
  assert.equal(evalExprCell('=2 * 3', {}, 0).value, 6, 'a plain number result passes through')
})

test('broken text is invalid and the cook writes the column default', () => {
  assert.equal(checkExprCell('=nope(').valid, false)
  assert.equal(checkExprCell('=noSuchFn(1)').valid, false)
  assert.equal(checkExprCell("=slider('h')").streaming, true)
  assert.equal(checkExprCell('=lit(1).add(2)').streaming, false)

  const src: Row[] = [{ beat: 1, value: '=nope(' }]
  const rows = evalRowExprCells(src, { beat: 'number', value: 'number' })
  assert.deepEqual(rows[0], { beat: 1, value: 0 })
  assert.deepEqual(src[0], { beat: 1, value: '=nope(' }, 'input rows are never mutated')
})

test('evaluation is deterministic: same text, same row, same result', () => {
  assert.deepEqual(
    evalExprCell('=field("v").mul(2)', { v: 3 }, 0),
    evalExprCell('=field("v").mul(2)', { v: 3 }, 0),
  )
})

test('a slider() call in a cell declares through the worker runtime', () => {
  const service = createCookService()
  const resp = service.handle({
    id: 1,
    code: 'editable("fx", { beat: "number", value: "number" })',
    seed: 0,
    dataCache: [],
    tapRows: [],
    editables: [{ name: 'fx', rows: [{ beat: 1, value: "=slider('glow', 0, 2)" }] }],
  }) as Extract<CookResponse, { ok: true }>
  assert.equal(resp.ok, true)
  assert.deepEqual(resp.sliders, [{ id: 'glow', min: 0, max: 2 }], 'the declaration reached defineSlider')
  const fx = resp.cooked.views.find((v) => v.name === 'fx')!
  assert.ok(isBinding(fx.rows[0].value), 'the cell cooked to a streaming binding in the served rows')
  assert.equal(resolve(fx.rows[0].value, 1.5), 1.5)
})
