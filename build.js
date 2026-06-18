import * as esbuild from 'esbuild'
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

rmSync('docs', { recursive: true, force: true })
mkdirSync('docs/assets', { recursive: true })

await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  outfile: 'docs/assets/index.js',
  format: 'esm',
})

const html = readFileSync('index.html', 'utf8')
  .replace('</head>', '    <link rel="stylesheet" href="/assets/index.css">\n  </head>')
  .replace('src="/src/main.js"', 'src="/assets/index.js"')
writeFileSync('docs/index.html', html)
