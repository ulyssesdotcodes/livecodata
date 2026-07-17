// The one definition of the JSON frames exchanged between the client
// (src/multiplayer.ts) and either server backend (server/server.ts,
// worker/room.ts). The parse functions own the validate guard shared by every
// endpoint: garbage, unknown types, and missing fields come back as null and
// are dropped silently.

import type { StampedEvent } from './event-log.js'

export interface JoinMessage {
  type: 'join'
  // Required by the Node server (it multiplexes rooms on one endpoint);
  // ignored by the Durable Object (the worker already routed by ?room=).
  room?: string
  // Servers fall back to 'anon' when absent.
  client?: string
  // The joiner's full logs — seeds an empty room and heals offline gaps.
  logs?: Record<string, StampedEvent[]>
}

export interface EventsMessage {
  type: 'events'
  log: string
  events: StampedEvent[]
}

export interface SyncMessage {
  type: 'sync'
  logs: Record<string, StampedEvent[]>
}

export type ClientMessage = JoinMessage | EventsMessage
export type ServerMessage = SyncMessage | EventsMessage

export function eventsMessage(log: string, events: StampedEvent[]): EventsMessage {
  return { type: 'events', log, events }
}

export function syncMessage(logs: Map<string, StampedEvent[]>): SyncMessage {
  const snapshot: Record<string, StampedEvent[]> = {}
  for (const [name, events] of logs) snapshot[name] = events
  return { type: 'sync', logs: snapshot }
}

function parseJson(raw: unknown): Record<string, unknown> | null {
  let msg: unknown
  try {
    msg = JSON.parse(String(raw))
  } catch {
    return null
  }
  return typeof msg === 'object' && msg !== null ? (msg as Record<string, unknown>) : null
}

function validLogs(logs: unknown): Record<string, StampedEvent[]> {
  const out: Record<string, StampedEvent[]> = {}
  if (typeof logs !== 'object' || logs === null) return out
  for (const [name, events] of Object.entries(logs)) {
    if (Array.isArray(events)) out[name] = events as StampedEvent[]
  }
  return out
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  const msg = parseJson(raw)
  if (!msg) return null
  if (msg.type === 'join') {
    return {
      type: 'join',
      ...(typeof msg.room === 'string' ? { room: msg.room } : {}),
      ...(typeof msg.client === 'string' ? { client: msg.client } : {}),
      logs: validLogs(msg.logs),
    }
  }
  if (msg.type === 'events' && typeof msg.log === 'string' && Array.isArray(msg.events)) {
    return { type: 'events', log: msg.log, events: msg.events as StampedEvent[] }
  }
  return null
}

export function parseServerMessage(raw: unknown): ServerMessage | null {
  const msg = parseJson(raw)
  if (!msg) return null
  if (msg.type === 'sync') return { type: 'sync', logs: validLogs(msg.logs) }
  if (msg.type === 'events' && typeof msg.log === 'string' && Array.isArray(msg.events)) {
    return { type: 'events', log: msg.log, events: msg.events as StampedEvent[] }
  }
  return null
}
