// livecodata editor completion helpers (pure; no CodeMirror/DOM deps)
// ----------------------------------------------------------------------------
// Deciding whether a "." should offer Expr methods or Table methods comes down
// to the root of the member-access chain to the left of the dot. Every Expr
// method returns an Expr, so a chain rooted at field()/lit()/idx() stays an Expr;
// everything else is treated as a Table. This is a small backward scanner over
// the program text (the editor is untyped JS-in-a-string, so we can't ask a type
// checker).
// ----------------------------------------------------------------------------

// Chain heads that produce an Expr.
export const EXPR_ROOTS: ReadonlySet<string> = new Set(['field', 'lit', 'idx'])

const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)
const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r'

// Given a "." at `dotPos`, walk the member-access chain to its left and return
// the head identifier (the call/identifier everything hangs off), or null if the
// receiver isn't a simple chain. Examples:
//   `field("v").gt(2).`       → "field"
//   `table("x").map(r=>r).`   → "table"
//   `r.value.`                → "r"
export function chainRoot(text: string, dotPos: number): string | null {
  let i = dotPos - 1

  const skipWs = (): void => { while (i >= 0 && isWs(text[i])) i-- }

  // text[i] is ) or ] — walk left past the balanced group (respecting nesting and
  // string literals) to the character before its opener.
  const skipBalanced = (): boolean => {
    const close = text[i]
    const open = close === ')' ? '(' : '['
    let depth = 0
    while (i >= 0) {
      const c = text[i]
      if (c === '"' || c === "'" || c === '`') {
        const q = c
        i--
        while (i >= 0 && !(text[i] === q && text[i - 1] !== '\\')) i--
        i--
        continue
      }
      if (c === close) depth++
      else if (c === open) { depth--; if (depth === 0) { i--; return true } }
      i--
    }
    return false
  }

  while (i >= 0) {
    skipWs()
    while (i >= 0 && (text[i] === ')' || text[i] === ']')) {
      if (!skipBalanced()) return null
      skipWs()
    }
    if (i < 0 || !isIdentChar(text[i])) return null
    const end = i
    while (i >= 0 && isIdentChar(text[i])) i--
    const ident = text.slice(i + 1, end + 1)
    skipWs()
    if (i >= 0 && text[i] === '.') { i--; continue } // member access — keep walking
    return ident
  }
  return null
}

// True when a "." at `dotPos` should complete Expr methods rather than Table ones.
export function isExprDot(text: string, dotPos: number): boolean {
  const root = chainRoot(text, dotPos)
  return root !== null && EXPR_ROOTS.has(root)
}

// True when a "." at `dotPos` sits right after a table's `.three` accessor
// (e.g. `box().three.`) — its receiver is the bare member `three` reached by a
// member access — so the dot should offer the three animators (rotate/scale/
// move) instead of the ordinary table methods.
export function isThreeDot(text: string, dotPos: number): boolean {
  let i = dotPos - 1
  while (i >= 0 && isWs(text[i])) i--
  if (i < 0 || !isIdentChar(text[i])) return false // a call/index close, not a bare member
  const end = i
  while (i >= 0 && isIdentChar(text[i])) i--
  if (text.slice(i + 1, end + 1) !== 'three') return false
  // Must be a member access (`.three`), not a stray identifier named three.
  while (i >= 0 && isWs(text[i])) i--
  return i >= 0 && text[i] === '.'
}
