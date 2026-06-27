// livecodata color — interpolate between two hex colors
// ----------------------------------------------------------------------------
// Mix two colors the same way the GPU would: three's Color.lerp is a linear-RGB
// interpolation (the shader `mix()`), so colors baked into the dense cache match
// what the renderer produces. This is pure data — no DOM — so it runs under the
// node test runner alongside the rest of rasterize.
// ----------------------------------------------------------------------------

import { Color } from 'three'

const _from = new Color()
const _to = new Color()

export function mixColor(from: number | null, to: number | null, t: number): number | null {
  if (from == null) return to ?? null
  if (to == null || t <= 0) return from
  if (t >= 1) return to
  _from.set(from)
  _to.set(to)
  _from.lerp(_to, t)
  return _from.getHex()
}
