export const FPS = 60

// Seconds per beat when no tempo has been tapped — 0.5s = 120 BPM.
export const DEFAULT_BEAT_SECONDS = 0.5

// Default loop length, in beats, for a program with no timeline to size it.
export const DEFAULT_LOOP_BEATS = 16

// Beats are the one time unit in the data model; frames are the internal baking
// grid. One beat is a FIXED number of frames so content placement is
// tempo-independent — tempo only scales playback SPEED, not where content sits.
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

// The one legitimate seconds→beat conversion: physics integrates in SI seconds
// and its output is placed on the beat grid (see physics.ts).
export function secondsToBeat(seconds: number): number {
  return seconds / DEFAULT_BEAT_SECONDS + 1
}
