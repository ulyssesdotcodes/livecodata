import { test } from 'node:test'
import assert from 'node:assert/strict'
import { minimalEdit } from '../src/editor-support.js'

// Apply a {from,to,insert} splice the way CodeMirror would, so the tests pin
// the behavioral contract (result text + which span moved), not the internals.
function apply(a: string, edit: { from: number; to: number; insert: string }): string {
  return a.slice(0, edit.from) + edit.insert + a.slice(edit.to)
}

test('minimalEdit: the splice turns a into b', () => {
  for (const [a, b] of [
    ['hello world', 'hello brave world'], // insert in the middle
    ['line1\nline2\nline3', 'line1\nline3'], // delete a middle line
    ['abc', 'xyz'], // full replace, no shared affixes
    ['', 'seeded'], // grow from empty
    ['drop me', ''], // shrink to empty
  ]) {
    assert.equal(apply(a, minimalEdit(a, b)), b, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
  }
})

test('minimalEdit: identical text is an empty no-op splice', () => {
  const edit = minimalEdit('same text', 'same text')
  assert.equal(edit.from, edit.to)
  assert.equal(edit.insert, '')
})

test('minimalEdit: leaves the shared prefix and suffix untouched', () => {
  // Only the "2" -> "9" in the middle should move; a caret in the prefix or
  // suffix must keep its offset, which is what preserves the editor view.
  const edit = minimalEdit('const beat = 2 // keep', 'const beat = 9 // keep')
  assert.equal(edit.from, 13)
  assert.equal(edit.to, 14)
  assert.equal(edit.insert, '9')
})
