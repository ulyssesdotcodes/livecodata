export const FPS = 60

// Seconds per beat when no tempo has been tapped — 0.5s = 120 BPM. Shared by
// the DSL's beats()/tempo() fallback and hydra's beat→seconds placement so a
// beat-synced sketch and a beats() timeline agree on the default grid.
export const DEFAULT_BEAT_SECONDS = 0.5

// Default loop length, in beats, for a program with no timeline to size it —
// the loop-length control's starting value (see playback.ts).
export const DEFAULT_LOOP_BEATS = 16
