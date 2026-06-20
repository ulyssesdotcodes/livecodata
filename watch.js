import * as esbuild from 'esbuild'

const ctx = await esbuild.context({
  entryPoints: ['src/main.js'],
  bundle: true,
  outfile: 'public/assets/index.js',
  format: 'esm',
})

await ctx.watch()

const { host, port } = await ctx.serve({ servedir: 'public' })
console.log(`Serving at http://${host}:${port}`)
