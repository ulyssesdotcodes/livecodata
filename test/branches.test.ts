import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBranchTree, branchEvents, APPLY_KIND } from '../src/branches.js'
import type { StampedEvent } from '../src/event-log.js'

// ── Builders ─────────────────────────────────────────────────────────────────
// Raw stamped events with explicit seq/src so a scenario reads like a log.

let clock = 0
function edit(seq: number, table = 't', src = 'A'): StampedEvent {
  return { seq, t: clock++, kind: 'set-cell', table, row: 0, col: 'x', value: seq, src }
}
function apply(
  seq: number,
  id: string,
  parent: string | null,
  edits: string[],
  seen: string | null | undefined = parent,
  src = 'A',
): StampedEvent {
  return { seq, t: clock++, kind: APPLY_KIND, table: 'activity', id, parent, edits, seen, src }
}
const key = (e: StampedEvent): string => `${e.src ?? ''}#${e.seq}`
const ids = (events: StampedEvent[]): string[] => events.map((e) => (e.kind === APPLY_KIND ? (e.id as string) : key(e)))

// ── Tree fold ────────────────────────────────────────────────────────────────

test('an empty log folds to an empty tree', () => {
  const tree = buildBranchTree([])
  assert.equal(tree.nodes.size, 0)
  assert.deepEqual(tree.heads, [])
  assert.deepEqual(tree.pathTo('nope'), [])
})

test('a legacy apply pulse (no id) is not a tree node', () => {
  const tree = buildBranchTree([{ seq: 0, t: 0, kind: APPLY_KIND, table: 'activity', src: 'A' }])
  assert.equal(tree.nodes.size, 0)
  assert.deepEqual(tree.heads, [])
})

test('a linear log folds to a single path with one head', () => {
  const log = [edit(0), apply(1, 'a1', null, ['A#0']), edit(2), apply(3, 'a2', 'a1', ['A#2'])]
  const tree = buildBranchTree(log)
  assert.deepEqual(tree.heads, ['a2'])
  assert.deepEqual(tree.pathTo('a2').map((n) => n.id), ['a1', 'a2'])
  assert.equal(tree.nodes.get('a2')!.fork, false)
})

test('a fork produces two heads that share the common prefix', () => {
  const log = [
    edit(0),
    apply(1, 'a1', null, ['A#0']),
    edit(2),
    apply(3, 'a2', 'a1', ['A#2']), // extends a1
    edit(4),
    apply(5, 'a3', 'a1', ['A#4'], 'a2'), // forks from a1, knowing a2
  ]
  const tree = buildBranchTree(log)
  assert.deepEqual(tree.heads, ['a2', 'a3'])
  assert.equal(tree.nodes.get('a2')!.fork, false)
  assert.equal(tree.nodes.get('a3')!.fork, true)
  assert.deepEqual(tree.pathTo('a2').map((n) => n.id), ['a1', 'a2'])
  assert.deepEqual(tree.pathTo('a3').map((n) => n.id), ['a1', 'a3'])
})

test('a fork of a fork branches again', () => {
  const log = [
    apply(1, 'a1', null, []),
    apply(2, 'a2', 'a1', [], 'a1'),
    apply(3, 'a3', 'a1', [], 'a2'), // fork of a1
    apply(4, 'a4', 'a3', [], 'a1'), // fork of a3 (seen a1)
  ]
  const tree = buildBranchTree(log)
  assert.deepEqual(new Set(tree.heads), new Set(['a2', 'a4']))
  assert.deepEqual(tree.pathTo('a4').map((n) => n.id), ['a1', 'a3', 'a4'])
})

test('an apply with an unknown parent reparents to the root', () => {
  const tree = buildBranchTree([apply(1, 'a1', 'ghost', [])])
  assert.equal(tree.nodes.get('a1')!.parent, null)
  assert.deepEqual(tree.heads, ['a1'])
})

test('a missing seen reads as parent (no fork)', () => {
  const tree = buildBranchTree([apply(1, 'a1', null, []), apply(2, 'a2', 'a1', [], undefined)])
  assert.equal(tree.nodes.get('a2')!.fork, false)
  assert.deepEqual(tree.pathTo('a2').map((n) => n.id), ['a1', 'a2'])
})

test('a cycle in the parent chain is cut at the repeat', () => {
  // a1.parent = a2, a2.parent = a1 — corrupt. The fold must still terminate.
  const tree = buildBranchTree([apply(1, 'a1', 'a2', []), apply(2, 'a2', 'a1', [])])
  const path = tree.pathTo('a2')
  assert.ok(path.length >= 1 && path.length <= 2)
  // pathTo terminates (no infinite loop) and every id is distinct.
  assert.equal(new Set(path.map((n) => n.id)).size, path.length)
})

// ── Linearization of concurrent applies ──────────────────────────────────────

test('racing same-parent applies (seen == parent) chain into one line', () => {
  const log = [
    apply(1, 'a1', null, []),
    apply(3, 'a2', 'a1', [], 'a1', 'A'),
    apply(5, 'a3', 'a1', [], 'a1', 'B'), // raced a1 too, never saw a2
  ]
  const tree = buildBranchTree(log)
  assert.deepEqual(tree.heads, ['a3'], 'the two racers collapse to a single branch')
  assert.deepEqual(tree.pathTo('a3').map((n) => n.id), ['a1', 'a2', 'a3'])
  assert.equal(tree.nodes.get('a3')!.parent, 'a2', 'later racer reparented onto the earlier')
})

test('linearization is identical regardless of event array order', () => {
  const log = [apply(1, 'a1', null, []), apply(3, 'a2', 'a1', [], 'a1', 'A'), apply(5, 'a3', 'a1', [], 'a1', 'B')]
  const a = buildBranchTree(log)
  const b = buildBranchTree([...log].reverse())
  assert.deepEqual(a.heads, b.heads)
  assert.deepEqual(a.pathTo('a3').map((n) => n.id), b.pathTo('a3').map((n) => n.id))
})

test('a fork racing a tip apply keeps its own branch', () => {
  const log = [
    apply(1, 'a1', null, []),
    apply(3, 'a2', 'a1', [], 'a1'), // ordinary extend
    apply(5, 'a3', 'a1', [], 'a2'), // deliberate fork (seen a2 != parent a1)
  ]
  const tree = buildBranchTree(log)
  assert.deepEqual(tree.heads, ['a2', 'a3'])
  assert.equal(tree.nodes.get('a3')!.parent, 'a1', 'a fork is not chained onto the racer')
})

// ── Membership (branchEvents) ────────────────────────────────────────────────

test('the motivating case: each branch folds exactly its claimed edits plus the shared prefix', () => {
  // apply1 -> edit -> apply2 ; scrub to apply1, edit, apply3
  const log = [
    edit(0), // A#0 — claimed by a1
    apply(1, 'a1', null, ['A#0']),
    edit(2), // A#2 — claimed by a2
    apply(3, 'a2', 'a1', ['A#2']),
    edit(4), // A#4 — claimed by a3, authored after scrubbing back to a1
    apply(5, 'a3', 'a1', ['A#4'], 'a2'),
  ]
  const tree = buildBranchTree(log)
  assert.deepEqual(ids(branchEvents(log, 'a2', tree)), ['A#0', 'a1', 'A#2', 'a2'])
  assert.deepEqual(ids(branchEvents(log, 'a3', tree)), ['A#0', 'a1', 'A#4', 'a3'])
})

test('a dangling edits id dereferences to nothing and is skipped', () => {
  const log = [edit(0), apply(1, 'a1', null, ['A#0', 'A#99'])]
  const tree = buildBranchTree(log)
  assert.deepEqual(ids(branchEvents(log, 'a1', tree)), ['A#0', 'a1'])
})

test('an edit claimed by two applies on one path folds once', () => {
  const log = [
    apply(1, 'a1', null, []),
    edit(2), // A#2 — shared pending both racers had seen
    apply(3, 'a2', 'a1', ['A#2'], 'a1', 'A'),
    apply(5, 'a3', 'a1', ['A#2'], 'a1', 'B'),
  ]
  const tree = buildBranchTree(log)
  const folded = ids(branchEvents(log, 'a3', tree))
  assert.equal(folded.filter((k) => k === 'A#2').length, 1, 'shared edit folds once')
  assert.deepEqual(folded, ['a1', 'A#2', 'a2', 'a3'])
})

test('head null (legacy/fresh) returns the whole log in order', () => {
  const log = [edit(2), edit(0), edit(1)]
  const tree = buildBranchTree(log)
  assert.deepEqual(ids(branchEvents(log, null, tree)), ['A#0', 'A#1', 'A#2'])
})

// ── Working tail overlay ─────────────────────────────────────────────────────

test('unclaimed edits after the newest apply overlay the live (leaf) head only', () => {
  const log = [
    edit(0),
    apply(1, 'a1', null, ['A#0']),
    apply(3, 'a2', 'a1', []), // newest apply
    edit(4), // A#4 — pending, unclaimed, after the newest apply
  ]
  const tree = buildBranchTree(log)
  // a2 is the leaf/live tip → the pending edit overlays it.
  assert.deepEqual(ids(branchEvents(log, 'a2', tree)), ['A#0', 'a1', 'a2', 'A#4'])
  // a1 is a scrubbed-back, non-leaf node → no overlay.
  assert.deepEqual(ids(branchEvents(log, 'a1', tree)), ['A#0', 'a1'])
})

test('an unclaimed edit before the newest apply does not overlay (it was abandoned)', () => {
  const log = [
    edit(0),
    apply(1, 'a1', null, ['A#0']),
    edit(2), // A#2 — abandoned: unclaimed but BEFORE the newest apply
    apply(3, 'a2', 'a1', []),
  ]
  const tree = buildBranchTree(log)
  assert.deepEqual(ids(branchEvents(log, 'a2', tree)), ['A#0', 'a1', 'a2'])
})

// ── Merge determinism ────────────────────────────────────────────────────────

test('two logs forked from a common prefix fold to the same tree once merged', () => {
  const shared = [edit(0), apply(1, 'a1', null, ['A#0'])]
  const mine = [...shared, edit(2), apply(3, 'a2', 'a1', ['A#2'], 'a1', 'A')]
  const theirs = [...shared, edit(2, 't', 'B'), apply(3, 'b2', 'a1', ['B#2'], 'a1', 'B')]
  const merged = [...mine, theirs[2], theirs[3]]
  const t1 = buildBranchTree(merged)
  const t2 = buildBranchTree([...merged].reverse())
  assert.deepEqual(t1.heads, t2.heads)
  // a2 and b2 both extend a1 (seen == parent) → they chain into one line.
  assert.equal(t1.heads.length, 1)
})
