export const FPS = 60

// Seconds per beat when no tempo has been tapped — 0.5s = 120 BPM. This is the
// default the DSL's beats()/tempo() fall back to, and — as FRAMES_PER_BEAT — the
// FIXED conversion between the `beat` time unit every table uses and the
// internal frame grid the caches are baked on.
export const DEFAULT_BEAT_SECONDS = 0.5

// Default loop length, in beats, for a program with no timeline to size it —
// the loop-length control's starting value (see playback.ts).
export const DEFAULT_LOOP_BEATS = 16

// Beats are the one time unit in livecodata: every table's `beat` column, every
// duration (dur), every rasterize/math length is in beats — there are no more
// "seconds" in the data model. Frames remain the internal baking grid, and one
// beat is a FIXED number of frames (30 = 0.5s at 60fps), so content placement is
// tempo-independent: a physics collision at beat 4 and a hydra keyframe at beat 4
// line up regardless of the tapped tempo. Tempo enters only through the beats()
// timeline, which scales playback SPEED, not where content sits on the grid.
export const FRAMES_PER_BEAT = Math.round(DEFAULT_BEAT_SECONDS * FPS)

// A 1-indexed `beat` (beat 1 = the first frame) ↔ its 0-based cache frame.
export function beatToFrame(beat: number): number {
  return Math.round((beat - 1) * FRAMES_PER_BEAT)
}

export function frameToBeat(frame: number): number {
  return frame / FRAMES_PER_BEAT + 1
}

// A *span* of beats (a length/duration, not a 1-indexed position) ↔ frames.
export function beatsToFrames(nBeats: number): number {
  return Math.round(nBeats * FRAMES_PER_BEAT)
}

export function framesToBeats(nFrames: number): number {
  return nFrames / FRAMES_PER_BEAT
}

// Wall-clock seconds → a 1-indexed beat, at the fixed grid tempo. The one place
// a seconds→beat conversion is legitimate: physics integrates in SI seconds and
// its output is placed on the beat grid (see physics.ts).
export function secondsToBeat(seconds: number): number {
  return seconds / DEFAULT_BEAT_SECONDS + 1
}
