// Default dimensions for the DSL's scene shapes.
// ----------------------------------------------------------------------------
// The renderer (three-scene.ts makeGeometry) and the physics engine
// (physics.ts makeShape) build the *same object* from the same row — rendered
// geometry and collision shape must agree, or visuals silently desynchronize
// from the simulation. Both import this one table so an edit can't reach one
// side only. Conventions shared by both: hx/hy/hz are half-extents (a box
// renders as 2·h per axis), r is a radius, h is a half-height (cylinders and
// cones render as 2·h).
// ----------------------------------------------------------------------------

export const SHAPE_DEFAULTS: Record<string, Record<string, number>> = {
  box:      { hx: 0.25, hy: 0.25, hz: 0.25 },
  sphere:   { r: 0.3 },
  cylinder: { r: 0.2, h: 0.3 },
  cone:     { r: 0.3, h: 0.3 },
  torus:    { r: 0.3 },
}
