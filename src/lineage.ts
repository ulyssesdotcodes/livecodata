// livecodata lineage — provenance tags on rows
// ----------------------------------------------------------------------------
// Every derived row can carry a hidden tag recording which source rows it came
// from, so at any frame we can trace the on-screen state back to the exact rows
// of each dataset that produced it ("which parts of each dataset are used now").
//
// A lineage ref is { table, index } where `index` is the row's ordinal position
// within that named view's rows — which is exactly how the table/graph panels
// address rows, so highlighting is a direct lookup.
//
// The tag is stored under a Symbol key. It is enumerable, so it rides along
// through `{ ...row }` spreads (the DSL's normal way of copying rows), but it
// never appears in Object.keys — so it stays out of the display columns and out
// of JSON.stringify (which ignores symbol keys).
// ----------------------------------------------------------------------------

// Unique-symbol trick: declare a const unique symbol type, then cast the
// runtime Symbol.for value to it so TypeScript accepts it as a computed property
// key in interfaces and object types.
declare const _lineageUnique: unique symbol
type LineageSymbol = typeof _lineageUnique

export const LINEAGE = Symbol.for('livecodata.lineage') as unknown as LineageSymbol

export type Row = Record<string, unknown>

export interface LineageRef {
  table: string
  index: number
}

type TaggedRow = Row & { [LINEAGE]?: LineageRef[] }

export function getLineage(row: Row): LineageRef[] {
  return (row as TaggedRow)[LINEAGE] ?? []
}

export function withLineage<T extends Row>(row: T, refs: LineageRef[]): T {
  if (refs && refs.length) (row as TaggedRow)[LINEAGE] = refs
  return row
}

export function carry(row: Row): LineageRef[] {
  return [...getLineage(row)]
}

export function unionLineage(rows: Row[]): LineageRef[] {
  const out: LineageRef[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    for (const ref of getLineage(r)) {
      const key = ref.table + ' ' + ref.index
      if (!seen.has(key)) {
        seen.add(key)
        out.push(ref)
      }
    }
  }
  return out
}

export function activeLineage(rows: Row[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>()
  for (const r of rows ?? []) {
    for (const ref of getLineage(r)) {
      if (!map.has(ref.table)) map.set(ref.table, new Set())
      map.get(ref.table)!.add(ref.index)
    }
  }
  return map
}
