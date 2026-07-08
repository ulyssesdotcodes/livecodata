// livecodata Cloudflare Worker entry point
// ----------------------------------------------------------------------------
// The Workers/Durable-Objects twin of server/server.ts: serves the built app
// from the [assets] binding (populated by `npm run build` before deploy) and
// routes /ws?room=<name> to that room's Durable Object instance — one per
// room name, via idFromName — which speaks the same protocol as the Node
// server's WebSocket relay (see room.ts / src/multiplayer.ts). The room name
// has to be resolvable from the request itself, before any upgrade happens,
// so the client puts it on the URL (?room=) as well as in its first "join"
// message.
// ----------------------------------------------------------------------------

export { Room } from './room.js'

interface Env {
  ROOMS: DurableObjectNamespace
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room')
      if (!room) return new Response('missing ?room=', { status: 400 })
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 })
      }
      const id = env.ROOMS.idFromName(room)
      return env.ROOMS.get(id).fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
