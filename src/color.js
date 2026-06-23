// livecodata color — interpolate between two hex colors
// ----------------------------------------------------------------------------
// Mix two colors the same way the GPU would: three's Color.lerp is a linear-RGB
// interpolation (the shader `mix()`), so colors baked into the dense cache match
// what the renderer produces. This is pure data — no DOM — so it runs under the
// node test runner alongside the rest of rasterize.
// ----------------------------------------------------------------------------

import { Color } from 'three'

// Scratch instances reused across the (potentially tens of thousands of) per-
// frame mixes a rasterize pass performs, to avoid allocating on every call.
const _from = new Color()
const _to = new Color()

// Mix hex int `from` → `to` by t. Endpoints return exactly (no color-management
// round-trip), so a pulse's flash frame is its precise color and a fully-decayed
// pulse lands exactly on its base. Null operands degrade gracefully.
export function mixColor(from, to, t) {
  if (from == null) return to ?? null
  if (to == null || t <= 0) return from
  if (t >= 1) return to
  _from.set(from)
  _to.set(to)
  _from.lerp(_to, t)
  return _from.getHex()
}
