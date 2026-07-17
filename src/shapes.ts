// Default dimensions for the DSL's scene shapes. The renderer (three-scene.ts
// makeGeometry) and the physics engine (physics.ts makeShape) both import this
// one table so rendered geometry and collision shape can't desynchronize.
// hx/hy/hz are half-extents, r a radius, h a half-height (rendered as 2·h).

export const SHAPE_DEFAULTS: Record<string, Record<string, number>> = {
  box:      { hx: 0.25, hy: 0.25, hz: 0.25 },
  sphere:   { r: 0.3 },
  cylinder: { r: 0.2, h: 0.3 },
  cone:     { r: 0.3, h: 0.3 },
  torus:    { r: 0.3 },
}
