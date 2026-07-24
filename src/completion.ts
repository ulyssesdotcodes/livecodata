// Editor completion helpers (pure; no CodeMirror/DOM deps). Whether a "."
// offers Expr or Table methods comes down to the root of the member-access
// chain: every Expr method returns an Expr, so a chain rooted at the `expr`
// namespace (expr.field(...)...) stays an Expr. The program is untyped
// JS-in-a-string, so this is a backward text scan, not a type-checker query.

export const EXPR_ROOTS: ReadonlySet<string> = new Set(['expr'])

const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)
const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r'

// Walk the member-access chain left of the "." at `dotPos` and return its head
// identifier (`field("v").gt(2).` → "field"), or null if the receiver isn't a
// simple chain.
export function chainRoot(text: string, dotPos: number): string | null {
  let i = dotPos - 1

  const skipWs = (): void => { while (i >= 0 && isWs(text[i])) i-- }

  // text[i] is ) or ] — walk left past the balanced group (respecting nesting
  // and string literals) to before its opener.
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

// The identifier immediately left of the dot at `dotPos`, and whether that
// identifier is itself a member access (preceded by another dot). The one
// backward scan isThreeDot/isExprNamespaceDot both dispatch on.
function identBeforeDot(text: string, dotPos: number): { name: string; isMember: boolean } | null {
  let i = dotPos - 1
  while (i >= 0 && isWs(text[i])) i--
  if (i < 0 || !isIdentChar(text[i])) return null // a call/index close, not a bare member
  const end = i
  while (i >= 0 && isIdentChar(text[i])) i--
  const name = text.slice(i + 1, end + 1)
  while (i >= 0 && isWs(text[i])) i--
  return { name, isMember: i >= 0 && text[i] === '.' }
}

// The dot right after the bare `expr` global (namespace member access, offers
// field/lit/midi/…) — as opposed to a dot later in the chain, which is on an
// Expr value and offers the Expr methods.
export function isExprNamespaceDot(text: string, dotPos: number): boolean {
  const r = identBeforeDot(text, dotPos)
  return r !== null && r.name === 'expr' && !r.isMember
}

export function isExprDot(text: string, dotPos: number): boolean {
  if (isExprNamespaceDot(text, dotPos)) return false
  const root = chainRoot(text, dotPos)
  return root !== null && EXPR_ROOTS.has(root)
}

// ── Language-service entry mapping ───────────────────────────────────────────
// TS completion entries → CodeMirror option fields; lives here (not
// editor-support.ts) so node tests can cover it without CodeMirror imports.

// ts.ScriptElementKind → CodeMirror completion type (drives the option icon).
export function cmCompletionType(tsKind: string): string {
  switch (tsKind) {
    case 'method':
    case 'construct':
      return 'method'
    case 'function':
    case 'local function':
      return 'function'
    case 'property':
    case 'getter':
    case 'setter':
      return 'property'
    case 'class': return 'class'
    case 'interface': return 'interface'
    case 'enum':
    case 'enum member':
      return 'enum'
    case 'type':
    case 'type parameter':
    case 'primitive type':
      return 'type'
    case 'keyword': return 'keyword'
    case 'module': return 'namespace'
    case 'string': return 'text'
    default: return 'variable' // var/let/const/local var/parameter/alias/…
  }
}

// TS sortText is a two-digit priority band ("11" locals … "15" globals and
// keywords; see ts.Completions.SortText). Locals float, keywords sink, and
// curated DSL names pin above the standard-library noise.
export function completionBoost(sortText: string, tsKind: string, hasCuratedDoc: boolean): number {
  const band = parseInt(sortText, 10)
  let boost = Number.isNaN(band) ? -3 : band <= 11 ? 2 : band <= 14 ? 1 : 0
  if (hasCuratedDoc) boost = Math.max(boost, 2)
  if (tsKind === 'keyword') boost = -2
  return boost
}

// True when the "." at `dotPos` follows a table's `.three` accessor (e.g.
// `box().three.`), so the dot offers the three animators instead of the
// ordinary table methods. Must be a member access (`.three`), not a stray
// identifier named three.
export function isThreeDot(text: string, dotPos: number): boolean {
  const r = identBeforeDot(text, dotPos)
  return r !== null && r.name === 'three' && r.isMember
}
