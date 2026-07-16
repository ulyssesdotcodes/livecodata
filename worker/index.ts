// Cloudflare Worker entry: serves the built app from the [assets] binding and
// routes /ws?room=<name> to that room's Durable Object (worker/room.ts). The
// room name rides on the URL because it must be resolvable from the request
// itself, before the websocket upgrade — not just in the first "join" message.

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
