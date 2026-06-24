// livecodata shared constants
// ----------------------------------------------------------------------------
// The single source of truth for values that several modules must agree on, so
// they can't silently drift apart.
// ----------------------------------------------------------------------------

// Frames per second: the rate the engine bakes and plays back at. All timing in
// the DSL is in seconds; this is the one place seconds ↔ frame indices convert.
// rasterize, effects, playback, timeline, and math().range all key off it.
export const FPS = 60
