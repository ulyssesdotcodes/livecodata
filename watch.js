import * as esbuild from 'esbuild'
import { solidPlugin } from 'esbuild-plugin-solid'
import { mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs'
import { startMultiplayerServer } from './server/server.js'
import { writeLangEnv } from './scripts/gen-lang-env.js'

mkdirSync('public/assets', { recursive: true })
mkdirSync('public/data', { recursive: true })
cpSync('src/data', 'public/data', { recursive: true })
cpSync('static', 'public', { recursive: true })

// The language-service environment the lang worker fetches — regenerated on
// each watch start (not on every edit; a dsl.ts type change needs a restart).
writeLangEnv('public/assets/lang-env.json')

const html = readFileSync('index.html', 'utf8')
  .replace('</head>', '    <link rel="stylesheet" href="./assets/index.css">\n  </head>')
  .replace('src="/src/main.ts"', 'src="./assets/index.js"')
writeFileSync('public/index.html', html)

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'public/assets/index.js',
  format: 'esm',
  external: ['module'], // see build.js
  plugins: [solidPlugin()],
})

// The cook worker bundle — see build.js.
const workerCtx = await esbuild.context({
  entryPoints: ['src/cook-worker.ts'],
  bundle: true,
  outfile: 'public/assets/cook-worker.js',
  format: 'esm',
  external: ['module'],
})

// The language-service worker bundle (TypeScript for the browser) — see build.js.
const langWorkerCtx = await esbuild.context({
  entryPoints: ['src/lang-worker.ts'],
  bundle: true,
  outfile: 'public/assets/lang-worker.js',
  format: 'esm',
})

await ctx.watch()
await workerCtx.watch()
await langWorkerCtx.watch()

// Serve the built app *and* the multiplayer room socket from the same
// process (see server/server.ts) — a jam works out of the box in dev, same
// as `npm run serve`, with no separate ?server= override needed. esbuild
// rebuilds public/assets/index.js on change in the background; this just
// reads whatever's currently on disk, same tradeoff as any esbuild+ctx.watch()
// setup (a refresh mid-rebuild can lag by a build cycle).
const port = Number(process.env.PORT) || 8787
const server = await startMultiplayerServer({ port, root: 'public' })
console.log(`Serving at http://localhost:${server.port} (ws at /ws) — rebuilding on change`)
