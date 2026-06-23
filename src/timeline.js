// livecodata timeline — DSL-driven playback time
// ----------------------------------------------------------------------------
// The playback timeline is itself an (optional) table. A "timeline" view maps
// each playback tick (a row's ordinal position, in frames) to a source time in
// the dense cache, via a `time` field in **seconds**. That makes retime / loop /
// ease / hold / reverse plain table data the DSL produces — e.g.
//
//   define("timeline", () => math(t => t % 1).range(6).map(r => ({ time: r.value })))
//
// With no timeline view, playback is the identity: tick i shows cache frame i.
// ----------------------------------------------------------------------------

const FPS = 60 // must match rasterize.js

// Build a tick → frame mapping from a timeline view's rows. Returns
// { length, frameAt(tick) }. `length` is the number of playback ticks (0 when
// there is no timeline, signalling the caller to fall back to the cache length).
// Each row's `time` field is source time in seconds; `frameAt` converts to the
// integer frame index used by the dense cache.
export function buildTimeline(timelineRows) {
  const rows = timelineRows ?? []
  if (!rows.length) {
    return { length: 0, frameAt: (tick) => Math.floor(tick) }
  }
  const last = rows.length - 1
  return {
    length: rows.length,
    frameAt(tick) {
      const idx = Math.min(last, Math.max(0, Math.floor(tick)))
      const time = rows[idx].time ?? (idx / FPS)
      return Math.round(time * FPS)
    },
  }
}
