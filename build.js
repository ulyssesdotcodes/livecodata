import * as esbuild from 'esbuild'
import { solidPlugin } from 'esbuild-plugin-solid'
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs'

rmSync('public', { recursive: true, force: true })
mkdirSync('public/assets', { recursive: true })
cpSync('src/data', 'public/data', { recursive: true })

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  outfile: 'public/assets/index.js',
  format: 'esm',
  // Jolt's emscripten glue has a node-only branch that does
  // `await import("module")`; keep it external so it isn't resolved at build
  // time (the browser never reaches that node-detection path).
  external: ['module'],
  plugins: [solidPlugin()],
})

const html = readFileSync('index.html', 'utf8')
  .replace('</head>', '    <link rel="stylesheet" href="./assets/index.css">\n  </head>')
  .replace('src="/src/main.ts"', 'src="./assets/index.js"')
writeFileSync('public/index.html', html)
