import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLangEnv } from '../scripts/gen-lang-env.js'
import { createLangService } from '../src/lang-service.js'
import { cmCompletionType, completionBoost } from '../src/completion.js'
import {
  curatedDocFor, DSL_BUILTIN_DOCS, TABLE_METHOD_DOCS, EXPR_METHOD_DOCS, THREE_METHOD_DOCS,
} from '../src/editor-support.js'

// One env + service for the whole file: building the env runs a real tsc
// declaration emit (~seconds), and the service reuses its program across
// queries exactly as the worker does.
const env = buildLangEnv()
const svc = createLangService(env)

const namesAt = (text: string, pos = text.length): string[] => {
  const res = svc.completionsAt(text, pos)
  assert.ok(res, `expected completions at ${pos} in ${JSON.stringify(text)}`)
  return res.entries.map((e) => e.name)
}

test('env: DSL surface enumerated from dsl.ts, declarations + libs present', () => {
  assert.ok(env.surfaceProps.includes('field'))
  assert.ok(env.surfaceProps.includes('table'))
  assert.ok(env.surfaceProps.includes('origami'))
  assert.ok(env.files['/dts/dsl.d.ts'].includes('DSLSurface'))
  assert.ok(env.files['/globals.d.ts'].includes('const field:'))
  assert.ok(env.files['/lib.es2022.d.ts'])
})

test('member completions on a Table chain come from the checker', () => {
  const names = namesAt('const t = table("sim")\nt.')
  for (const m of ['map', 'filter', 'rasterize', 'three', 'concat', 'rows']) {
    assert.ok(names.includes(m), `expected Table member ${m}`)
  }
  assert.ok(!names.includes('add'), 'Expr methods must not appear on a Table')
  assert.ok(!names.some((n) => n.startsWith('_')), 'internals are filtered out')
})

test('Expr chains complete Expr methods, not Table ones', () => {
  const names = namesAt('field("v").gt(2).')
  for (const m of ['add', 'and', 'cond', 'mul']) assert.ok(names.includes(m), `expected Expr member ${m}`)
  assert.ok(!names.includes('rasterize'), 'Table methods must not appear on an Expr')
})

test('a chain the old heuristic could not type still completes', () => {
  // The receiver is a local const holding a Table — no field()/table() chain
  // root in sight of the dot, so only the checker can answer this.
  const names = namesAt('const scene = box().concat(sphere())\nconst out = scene\nout.')
  assert.ok(names.includes('rasterize'))
  assert.ok(names.includes('three'))
})

test('.three completes the scene animators', () => {
  const res = svc.completionsAt('box().three.', 'box().three.'.length)
  assert.ok(res && res.isMemberCompletion)
  for (const m of ['rotate', 'scale', 'move']) assert.ok(res.entries.some((e) => e.name === m), `expected animator ${m}`)
})

test('globals include the DSL surface, console, and the ES library', () => {
  const names = namesAt('fie', 3)
  for (const g of ['field', 'define', 'box', 'console', 'Math']) assert.ok(names.includes(g), `expected global ${g}`)
})

test('quickinfo shows the complete signature', () => {
  const text = 'box({ id: "a" }).rasterize(8)'
  const qi = svc.quickInfoAt(text, text.indexOf('rasterize') + 1)
  assert.ok(qi)
  assert.match(qi.display, /rasterize\(maxBeats\?: number\): Table/)
  assert.equal(text.slice(qi.start, qi.end), 'rasterize')
})

test('quickinfo resolves overloads and locals', () => {
  const text = 'const t = table("x").map(r => r)\nt'
  const onMap = svc.quickInfoAt(text, text.indexOf('map') + 1)
  assert.ok(onMap)
  assert.match(onMap.display, /Table\.map/)
  assert.match(onMap.display, /overload/)
  const onLocal = svc.quickInfoAt(text, text.length - 1)
  assert.ok(onLocal)
  assert.match(onLocal.display, /const t: Table/)
})

test('completion details resolve the full member type', () => {
  const text = 'const t = table("sim")\nt.fil'
  const det = svc.detailsAt(text, text.length, 'filter')
  assert.ok(det)
  assert.match(det.display, /\(method\) Table\.filter/)
  assert.match(det.display, /Expr/)
})

test('signature help reports params and the active argument', () => {
  const text = 'table("x").orderBy('
  const sh = svc.signatureHelpAt(text, text.length, '(')
  assert.ok(sh)
  const item = sh.signatures[sh.activeSignature]
  assert.match(item.prefix, /orderBy\($/)
  assert.equal(item.params.length, 2)
  assert.match(item.params[0].label, /key/)
  assert.equal(sh.activeParameter, 0)

  const text2 = 'table("x").orderBy("beat", '
  const sh2 = svc.signatureHelpAt(text2, text2.length, ',')
  assert.ok(sh2)
  assert.equal(sh2.activeParameter, 1)
})

test('no answers inside an unparseable mess still return gracefully', () => {
  const qi = svc.quickInfoAt('((((', 2)
  assert.equal(qi, null)
})

test('cmCompletionType maps TS kinds onto CodeMirror icons', () => {
  assert.equal(cmCompletionType('method'), 'method')
  assert.equal(cmCompletionType('const'), 'variable')
  assert.equal(cmCompletionType('local var'), 'variable')
  assert.equal(cmCompletionType('getter'), 'property')
  assert.equal(cmCompletionType('keyword'), 'keyword')
  assert.equal(cmCompletionType('string'), 'text')
})

test('completionBoost ranks locals > curated DSL > plain globals > keywords', () => {
  const local = completionBoost('11', 'const', false)
  const dsl = completionBoost('15', 'const', true)
  const global = completionBoost('15', 'var', false)
  const keyword = completionBoost('15', 'keyword', false)
  assert.ok(local >= dsl, 'locals at least match DSL surface')
  assert.ok(dsl > global, 'curated DSL API above library globals')
  assert.ok(global > keyword, 'identifiers above keywords')
})

test('curatedDocFor picks the doc table from the chain context', () => {
  const t1 = 'table("x").map'
  assert.equal(curatedDocFor(t1, t1.indexOf('map'), 'map'), TABLE_METHOD_DOCS.map)
  const t2 = 'field("v").gt'
  assert.equal(curatedDocFor(t2, t2.indexOf('gt'), 'gt'), EXPR_METHOD_DOCS.gt)
  const t3 = 'box().three.rotate'
  assert.equal(curatedDocFor(t3, t3.indexOf('rotate'), 'rotate'), THREE_METHOD_DOCS.rotate)
  assert.equal(curatedDocFor('field', 0, 'field'), DSL_BUILTIN_DOCS.field)
  assert.equal(curatedDocFor('const x = 1', 6, 'x'), null)
})
