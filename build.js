import * as esbuild from 'esbuild'
import { solidPlugin } from 'esbuild-plugin-solid'
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs'

rmSync('public', { recursive: true, force: true })
mkdirSync('public/assets', { recursive: true })
cpSync('src/data', 'public/data', { recursive: true })
cpSync('static', 'public', { recursive: true })

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  outfile: 'public/assets/index.js',
  format: 'esm',
  external: ['module'],
  plugins: [solidPlugin()],
})

// The cook worker: its own bundle, loaded by the main bundle via
// new Worker(new URL('cook-worker.js', import.meta.url)). Jolt (whose
// emscripten glue has a node-only `await import("module")` branch — kept
// external so it isn't resolved at build time; the browser never reaches
// that node-detection path) now lives in here, not in the main bundle.
await esbuild.build({
  entryPoints: ['src/cook-worker.ts'],
  bundle: true,
  minify: true,
  outfile: 'public/assets/cook-worker.js',
  format: 'esm',
  external: ['module'],
})

const html = readFileSync('index.html', 'utf8')
  .replace('</head>', '    <link rel="stylesheet" href="./assets/index.css">\n  </head>')
  .replace('src="/src/main.ts"', 'src="./assets/index.js"')
writeFileSync('public/index.html', html)
