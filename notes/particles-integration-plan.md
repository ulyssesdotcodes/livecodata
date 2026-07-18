# GPU particle system integration plan

Bringing threely's curl-noise GPU particle system into livecodata.

## Where the code comes from

threely's `particle-specific` branch has a fully GPU-resident, real-time
compute particle system built on `three/webgpu` + TSL/WGSL:

- `src/compute/curl-noise.ts` — ~530 lines of WGSL via `THREE.TSL.wgslFn`:
  simplex noise, its analytic gradient (`srdnoise3`), octaves, and a `curl()`
  field that produces a per-particle curl-of-noise force. (The "curl math".)
- `src/compute/compute-init.ts` — allocates GPU storage buffers
  (`StorageInstancedBufferAttribute`) for `position/velocity/color/birthTime/
  lifespan`, seeds them with a TSL `Fn().compute()` kernel via
  `renderer.computeAsync`, and a per-frame `computeUpdate` kernel that
  integrates velocity, applies a force, and ages/respawns dead particles.
- `src/compute/points-renderer.ts` — wires the buffers into a
  `SpriteNodeMaterial` and drives `renderer.compute()` each frame.
- `src/particles.ts` — orchestrates 400k particles, applies the curl force,
  and feeds live tap-beat + mic-loudness signals into TSL uniforms.

## The core tension: two opposite execution models

|                     | livecodata scene/tables            | threely particles              |
| ------------------- | ---------------------------------- | ------------------------------ |
| State lives in      | CPU rows `{id,type,beat,…}`        | GPU storage buffers            |
| Time                | deterministic **beat timeline**, scrubbable/loopable/replayable | live `performance.now()`, **stateful** |
| Simulation          | **baked** ahead into per-frame rows (`rasterize.ts`) | continuous GPU compute, never on CPU |
| Multiplayer/session | rows sync & converge               | not row-representable           |
| Renderer            | one CPU-side `THREE.Mesh` per id   | one instanced sprite, N=100k+   |

Consequence: the particle sim **cannot** be a baked `Table` builder. You can't
bake 100k+ GPU particles into rows-per-frame, and you can't scrub/replay a
stateful GPU simulation by beat. So the earlier "particles table baked to rows"
idea does not describe this code.

## Chosen approach

Bring the particle system in as a **GPU visualizer sink** that lives alongside
the mesh scene and hydra — not as a baked table — and use livecodata's
deterministic layer to **drive the sim's TSL uniforms**:

- livecodata's `slider()`, `midi()`, `taps()`, `tempo()`, and `beat` map almost
  1:1 onto threely's `curlParams` / `beatramp` / `loudness` uniform feeds.
  (threely reinvented tap-beat + a slider UI that livecodata already has as
  first-class, syncable, automatable controls.)
- The original "events for spawner / move / add force" become **uniform
  updates** (spawn position, force vector, curl params, palette) — which *are*
  deterministic, bakeable, scrubbable, and multiplayer-safe. The heavy sim stays
  on the GPU; the control surface stays in livecodata's model.
- Particles render into the three scene → flow through the existing hydra
  post-processing for free.

Prerequisite (done): the scene renderer was switched to `three/webgpu`
(`WebGPURenderer`), which is what makes TSL/WGSL compute available.

## Caveats

1. **WebGPU only.** Compute shaders don't exist under the WebGL2 fallback, so
   particles simply don't run there (the rest of the scene still does). Needs a
   graceful "no particles" degradation — which the slice implements by only
   building the system when `renderer.backend.isWebGPUBackend`.
2. **Adaptation, not straight copy.** threely uses `@preact/signals` (livecodata
   uses solid-js), `new Function` eval of user particle code, and reads
   localStorage/mic directly. The uniform plumbing must be rewired to
   livecodata's DSL context, cook pipeline, and signal conventions.
3. **Scope.** The full integration is ~1200 lines of new GPU code + a visualizer
   + uniform plumbing. Architecturally significant.

## The slice (this change)

Goal: de-risk the rendering pipeline — confirm the GPU sim renders through
livecodata's WebGPU renderer + hydra pipeline in a real WebGPU browser. No
table, no DSL yet.

- `src/compute/curl-noise.ts` — ported **verbatim** from threely (self-contained;
  only imports `three/webgpu`).
- `src/compute/particles.ts` — livecodata-native `createParticleSystem(renderer)`:
  storage buffers, an init compute kernel, a combined update kernel
  (curl force → damp → integrate → age/respawn), a `SpriteNodeMaterial`
  coloured by velocity direction, additive blending. Returns `{ sprite, tick,
  params, dispose }`. `params` is read live via TSL `reference()`.
- `src/three-scene.ts` — after `renderer.init()`, if the backend is WebGPU,
  build the system, add its sprite to the scene, and `tick()` it each frame.
  Exposes `SceneAPI.setParticleParam(name, value)` (a no-op off WebGPU).
- `src/main.ts` — a slider named `particles` drives the curl `speed` uniform
  live, through the existing slider automation (`onTick`).

### Verifying the slice

- Typecheck, build, and unit tests must stay green.
- Under the WebGL2 fallback (e.g. headless Chromium in the `verify` harness),
  particles are skipped and the rest of the scene must render unchanged — this
  is the only thing verifiable in that environment.
- **Visual confirmation of particles requires a real WebGPU browser** (the
  headless verify environment has no WebGPU). To try it: define a `sliders`
  view with an `id: "particles"` row, Run, and drag the slider — the curl speed
  responds live.

## Next steps after the slice lands

1. Promote the system to a proper `Visualizer` sink (`visualizer.ts` /
   `main.ts` registration) rather than a hardcoded sprite in `three-scene.ts`.
2. Design the DSL control surface: a `particles` table / builder whose rows set
   uniforms (spawn position, force, curl params, palette, count).
3. Wire `beat`/`tempo`/`midi`/`taps` into uniforms (replacing threely's bespoke
   tap-beat + audio signals with livecodata's first-class ones).
4. Decide the degradation story for WebGL2-only browsers (hide vs. static
   fallback).
