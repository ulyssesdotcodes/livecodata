import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chainRoot, isExprDot, isThreeDot } from '../src/completion.js'

const rootAt = (s: string): string | null => {
  const dot = s.lastIndexOf('.')
  return chainRoot(s, dot)
}
const exprAt = (s: string): boolean => {
  const dot = s.lastIndexOf('.')
  return isExprDot(s, dot)
}

test('Expr chains resolve to their field/lit/idx root', () => {
  assert.equal(rootAt('field("index").'), 'field')
  assert.equal(rootAt('field("index").add(0.05).'), 'field')
  assert.equal(rootAt('field("v").gt(2).cond(1, 0).'), 'field')
  assert.equal(rootAt('lit(5).mul(2).'), 'lit')
  assert.equal(rootAt('idx().'), 'idx')
})

test('Table chains resolve to their table/rows/etc. root', () => {
  assert.equal(rootAt('table("sim").'), 'table')
  assert.equal(rootAt('table("sim").filter({ type: "x" }).'), 'table')
  assert.equal(rootAt('rows([{ a: 1 }]).map(r => r).'), 'rows')
  assert.equal(rootAt('physics(table("base")).simulate({ steps: 1 }).'), 'physics')
})

test('isExprDot distinguishes Expr from Table receivers', () => {
  assert.equal(exprAt('field("index").add(0.05).'), true)
  assert.equal(exprAt('table("sim").'), false)
  assert.equal(exprAt('table("sim").filter(field("type").eq("x")).'), false,
    'the OUTER dot is on a Table even though an Expr appears inside the args')
  assert.equal(exprAt('table("sim").filter(field("type").'), true,
    'an Expr nested inside call args is detected at its own dot')
})

test('nested parens and strings (with dots/parens inside) are skipped', () => {
  assert.equal(rootAt('field("a.b)(c").mul( (1 + 2) ).'), 'field')
  assert.equal(rootAt('table("x").map(r => ({ v: r.v })).'), 'table')
})

test('isThreeDot fires only right after a .three accessor', () => {
  const threeAt = (s: string): boolean => isThreeDot(s, s.lastIndexOf('.'))
  assert.equal(threeAt('box().three.'), true)
  assert.equal(threeAt('box({ id: "a" }).three.'), true)
  assert.equal(threeAt('scene.three.'), true)
  // The dot after box() offers `.three` among table methods — not the animators.
  assert.equal(threeAt('box().'), false)
  // After an animator call the receiver is a Table again, not the accessor.
  assert.equal(threeAt('box().three.rotate({ amount: 1 }).'), false)
  assert.equal(threeAt('table("scene").'), false)
})

test('non-chain receivers return null / not-Expr', () => {
  assert.equal(rootAt('(1 + 2).'), null)
  assert.equal(exprAt('(1 + 2).'), false)
})
