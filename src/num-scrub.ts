// The pure math of number-literal scrubbing (the CodeMirror extension lives
// in ui/num-scrub.ts): horizontal drag distance steps the value at the
// literal's own precision, vertical distance shifts magnitude — up = coarser
// ×10 per zone, down = finer ÷10 — the DAW convention.

export const PX_PER_STEP = 8
export const PX_PER_ZONE = 56
const MAX_ZONE = 3
const MAX_DECIMALS = 6

/**
 * The scrubbed text for a numeric literal after a drag of (dx, dy) pixels.
 * Step size comes from the literal's decimals ("0.35" steps by 0.01, "6" by
 * 1), scaled by the vertical zone. Returns formatted text, not a number, so
 * the caller can splice it straight into the document.
 */
export function scrubText(original: string, dx: number, dy: number): string {
  const value = Number(original)
  if (!Number.isFinite(value)) return original
  const decimals = original.includes('.') ? original.length - original.indexOf('.') - 1 : 0
  const zone = Math.max(-MAX_ZONE, Math.min(MAX_ZONE, Math.round(-dy / PX_PER_ZONE)))
  const step = Math.pow(10, zone - decimals)
  const steps = Math.round(dx / PX_PER_STEP)
  if (!steps) return original
  const next = value + steps * step
  // A coarser step changes the step, not the value's precision (0.35 + 0.1
  // still needs two decimals); a finer one needs more.
  const effDecimals = Math.min(MAX_DECIMALS, decimals + Math.max(0, -zone))
  const fixed = next.toFixed(effDecimals)
  return effDecimals > 0 ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}
