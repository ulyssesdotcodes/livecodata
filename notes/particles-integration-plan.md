# GPU particle system integration

Bringing threely's curl-noise GPU particle system into livecodata.

**Status:** the de-risking slice has landed — the GPU sim is wired into the
scene behind a WebGPU guard and driven by the playback clock. What remains is
promoting it to a real visualizer sink with a DSL control surface (see
[Remaining work](#remaining-work)).

## Where the code comes from

threely's `particle-specific` branch has a fully GPU-resident, real-time
compute particle system built on `three/webgpu` + TSL/WGSL:

- `src/compute/curl-noise.ts` — ~530 lines of WGSL via `THREE.TSL.wgslFn`:
  simplex noise, its analytic gradient (`srdnoise3`), octaves, and a `curl()`
  field that produces a per-particle curl-of-noise force. (The "curl math".)
- `src/compute/compute-init.ts` — GPU storage buffers, a seed kernel, and a
  per-frame update kernel (integrate, apply force, age/respawn).
- `src/compute/points-renderer.ts` — wires the buffers into a
  `SpriteNodeMaterial` and drives `renderer.compute()` each frame.
- `src/particles.ts` — orchestrates 400k particles, applies the curl force,
  and feeds live tap-beat + mic-loudness signals into TSL uniforms.

livecodata took `curl-noise.ts` verbatim and rewrote the rest natively (see
[What's built](#whats-built)).

## The core tension: two opposite execution models

|                     | livecodata scene/tables            | threely particles              |
| ------------------- | ---------------------------------- | ------------------------------ |
| State lives in      | CPU rows `{id,type,beat,…}`        | GPU storage buffers            |
| Time                | deterministic **beat timeline**, scrubbable/loopable/replayable | live, **stateful** |
| Simulation          | **baked** ahead into per-frame rows (`rasterize.ts`) | continuous GPU compute, never on CPU |
| Multiplayer/session | rows sync & converge               | not row-representable           |
| Renderer            | one CPU-side `THREE.Mesh` per id   | one instanced sprite, N=100k+   |

Consequence: the particle sim **cannot** be a baked `Table` builder. You can't
bake 100k+ GPU particles into rows-per-frame, and you can't scrub/replay a
stateful GPU simulation by beat. So a "particles table baked to rows" does not
describe this code.

## Chosen approach

Bring the particle system in as a **GPU visualizer sink** that lives alongside
the mesh scene and hydra — not as a baked table — and use livecodata's
deterministic layer to **drive the sim's TSL uniforms**:

- livecodata's `slider()`, `midi()`, `taps()`, `tempo()`, and `beat` map almost
  1:1 onto threely's `curlParams` / `beatramp` / `loudness` uniform feeds.
  (threely reinvented tap-beat + a slider UI that livecodata already has as
  first-class, syncable, automatable controls.)
- The "events for spawner / move / add force" become **uniform updates** (spawn
  position, force vector, curl params, palette) — which *are* deterministic,
  bakeable, scrubbable, and multiplayer-safe. The heavy sim stays on the GPU;
  the control surface stays in livecodata's model.
- Particles render into the three scene → flow through the existing hydra
  post-processing for free.

## What's built

Renderer prerequisite: the scene renderer was switched to `three/webgpu`
(`WebGPURenderer`, with an automatic WebGL2 fallback), which is what makes
TSL/WGSL compute available.

The particle slice (hardcoded sprite, no DSL surface yet):

- `src/compute/curl-noise.ts` — ported **verbatim** from threely (self-contained;
  only imports `three/webgpu`).
- `src/compute/particles.ts` — livecodata-native `createParticleSystem(renderer)`:
  storage buffers, an init compute kernel, a combined update kernel
  (curl force → damp → integrate → age/respawn), a `SpriteNodeMaterial`
  coloured by velocity direction, additive blending. Returns `{ sprite, tick,
  params, dispose }`. `params` is read live via TSL `reference()`.
- `src/three-scene.ts` — after `renderer.init()`, builds the system only when
  `renderer.backend.isWebGPUBackend` (compute shaders don't exist under the
  WebGL2 fallback), adds its sprite, and `tick(time)`s it each frame. Exposes
  `SceneAPI.setParticleParam(name, value)` and `setParticleTime(beats)` — both
  no-ops off WebGPU.
- `src/main.ts` — a slider named `particles` drives the curl `speed` uniform,
  and the playhead drives the sim clock, both through the playback `onTick`.

### Clock: the sim honours playback time

The sim does **not** use three's wall-clock `TSL.time`. Instead a `uniform`
clock is fed the playback position (beats) each `onTick`, and the GPU update
kernel runs only when that value moves. So the sim steps in lockstep with the
beat clock — playing advances it, pausing freezes it, scrubbing/looping moves
it — exactly like the scene and hydra visualizers. Curl-field evolution and
particle aging (lifespan is in beats) ride this same clock.

## Caveats

1. **WebGPU only.** Compute shaders don't exist under the WebGL2 fallback, so
   particles are skipped there (the rest of the scene renders unchanged). A
   richer degradation story (hide vs. static fallback) is still open.
2. **Stateful GPU sim vs. a scrubbable timeline.** Scrubbing *backward* jumps
   the noise field but can't rewind particle positions, and a loop wrap resets
   the clock sawtooth-style rather than looping the particle state seamlessly.
   Inherent to the model, not a bug.
3. **Adaptation, not straight copy.** threely uses `@preact/signals` (livecodata
   uses solid-js), `new Function` eval of user particle code, and reads
   localStorage/mic directly. Further uniform plumbing must be rewired to
   livecodata's DSL context, cook pipeline, and signal conventions.

## Verification

- Typecheck, build, and the full unit suite stay green.
- Graceful degradation is verified in the headless (WebGL2) `verify` harness:
  particles are skipped, the scene renders and animates unchanged, no errors —
  with playback running so the `setParticleTime` path is exercised.
- **The particles themselves need a real WebGPU browser to see** — the headless
  verify environment has no WebGPU. To try it: define a `sliders` view with an
  `id: "particles"` row, Run, and drag the slider (curl speed responds live);
  Play advances the sim, Pause freezes it, scrubbing jumps the field.

## Remaining work

1. Promote the system to a proper `Visualizer` sink (`visualizer.ts` /
   `main.ts` registration) rather than a hardcoded sprite in `three-scene.ts`.
2. Design the DSL control surface: a `particles` table / builder whose rows set
   uniforms (spawn position, force, curl params, palette, count).
3. Wire more of `beat`/`tempo`/`midi`/`taps` into uniforms (the sim clock
   already tracks the playhead; `beatramp`/loudness-style feeds remain).
4. Decide the WebGL2 degradation story (hide vs. static fallback).
