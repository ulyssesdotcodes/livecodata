// Mix two hex colors the way the GPU would: three's Color.lerp is linear-RGB
// (the shader `mix()`), so colors baked into the dense cache match what the
// renderer produces.

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
