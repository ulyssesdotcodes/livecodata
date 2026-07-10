// Transport controls — the humble view over the playback engine
// (../playback.ts). It renders PlaybackViewState verbatim and forwards every
// interaction straight to an engine method (or the TapControl); no playback
// logic lives here. createPlaybackController bundles the engine with the
// view-state signal it emits into; app.tsx renders <PlaybackControls> from
// that bundle (once main.ts has built it — the engine needs the scene/hydra
// APIs, which need the canvases the app render creates first).

import { createSignal, Show, type Accessor } from 'solid-js'
import { listenGlobal } from './dom.js'
import { createPlaybackEngine } from '../playback.js'
import type { PlaybackEngine, PlaybackOptions, PlaybackViewState, TapControl } from '../playback.js'
import { FRAMES_PER_BEAT, DEFAULT_LOOP_BEATS } from '../constants.js'
import type { SceneAPI } from '../three-scene.js'
import type { HydraAPI } from '../hydra-scene.js'

export function PlaybackControls(props: {
  vs: Accessor<PlaybackViewState>
  engine: PlaybackEngine
  tapControl?: TapControl
}) {
  const vs = props.vs
  const playing = () => vs().state === 'playing'
  const fillPct = () => (vs().maxBeats > 0 ? Math.min(100, (vs().scrubPos / vs().maxBeats) * 100) : 0)
  const timeText = () => {
    const { pos, srcBeat, timelineActive } = vs()
    return timelineActive ? `${(pos + 1).toFixed(2)}→${srcBeat.toFixed(2)} beat` : `beat ${srcBeat.toFixed(2)}`
  }

  // A scrub drag can end anywhere on the page, so the commit listens globally.
  listenGlobal(window, 'pointerup', () => props.engine.endScrub())

  return (
    <>
      <div class="playback-row">
        <button
          id="play-pause-btn"
          title={playing() ? 'Pause' : 'Play'}
          aria-label={playing() ? 'Pause' : 'Play'}
          onClick={() => props.engine.toggle()}
        >
          {playing() ? '⏸' : '▶'}
        </button>
        <button
          id="loop-btn"
          classList={{ active: vs().loop }}
          title="Loop playback"
          aria-label="Loop playback"
          onClick={() => props.engine.setLoop(!vs().loop)}
        >
          ↻
        </button>
        <label class="loop-len" title="Loop length in beats">
          <input
            id="loop-beats"
            type="number"
            min="1"
            step="1"
            value={String(vs().loopBeats)}
            onChange={(e) => {
              const el = e.currentTarget
              const n = Math.max(1, Math.round(parseFloat(el.value) || DEFAULT_LOOP_BEATS))
              // Snap the field to the clamped value: when n equals the current
              // loopBeats the signal doesn't change, so nothing reactive would
              // overwrite a rejected entry like "0" or "abc".
              el.value = String(n)
              props.engine.setLoopBeats(n)
            }}
          />
          <span>beats</span>
        </label>
        <span id="playback-time">{timeText()}</span>
      </div>
      <Show when={props.tapControl}>
        {(tap) => (
          <div class="playback-row tap-row">
            <button
              id="tap-beat-btn"
              title="Tap a beat to set the tempo — the whole loop plays at it"
              onClick={() => tap().tap()}
            >
              Tap
            </button>
            <span id="tap-bpm">{`${vs().bpm != null ? vs().bpm!.toFixed(1) : 120} BPM`}</span>
            <button id="tap-clear-btn" title="Clear taps" onClick={() => tap().clear()}>
              Clear
            </button>
          </div>
        )}
      </Show>
      <input
        type="range"
        id="scrub-bar"
        min="0"
        max={String(vs().maxBeats || 100)}
        step={String(1 / FRAMES_PER_BEAT)}
        value={String(vs().scrubPos)}
        style={{ background: `linear-gradient(to right, #e94560 ${fillPct()}%, #1a3a5e ${fillPct()}%)` }}
        onInput={(e) => props.engine.scrub(parseFloat(e.currentTarget.value))}
      />
    </>
  )
}

export interface PlaybackController {
  engine: PlaybackEngine
  vs: Accessor<PlaybackViewState>
  tapControl?: TapControl
}

export function createPlaybackController(
  sceneAPI: SceneAPI,
  hydraAPI: HydraAPI,
  options: PlaybackOptions = {},
): PlaybackController {
  const [vs, setVs] = createSignal<PlaybackViewState | null>(null)
  const engine = createPlaybackEngine(sceneAPI, hydraAPI, { ...options, onViewChange: setVs })
  if (vs() == null) setVs(engine.viewState())
  return { engine, vs: () => vs()!, tapControl: options.tapControl }
}
