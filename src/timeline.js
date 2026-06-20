// livecodata timeline — DSL-driven playback time
// ----------------------------------------------------------------------------
// The playback timeline is itself an (optional) table. A "timeline" view maps
// each playback tick (a row's ordinal position) to a source frame in the dense
// cache, via a `frame` field. That makes retime / loop / ease / hold / reverse
// plain table data the DSL produces — e.g.
//
//   define("timeline", () => math(i => i % 60).range(360).map(r => ({ frame: r.value })))
//
// With no timeline view, playback is the identity: tick i shows cache frame i.
// ----------------------------------------------------------------------------

// Build a tick → frame mapping from a timeline view's rows. Returns
// { length, frameAt(tick) }. `length` is the number of playback ticks (0 when
// there is no timeline, signalling the caller to fall back to the cache length).
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
      return Math.round(rows[idx].frame ?? idx)
    },
  }
}
