import * as esbuild from 'esbuild'
import { mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs'

mkdirSync('public/assets', { recursive: true })
mkdirSync('public/data', { recursive: true })
cpSync('src/data', 'public/data', { recursive: true })

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
})

await ctx.watch()

const { host, port } = await ctx.serve({ servedir: 'public' })
console.log(`Serving at http://${host}:${port}`)
