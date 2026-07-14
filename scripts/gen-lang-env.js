#!/usr/bin/env node
// Build the editor language-service environment: the virtual file system the
// in-browser TypeScript language service (src/lang-service.ts) analyzes user
// programs against. Written as JSON to public/assets/lang-env.json by
// build.js/watch.js so the lang worker can fetch it, and importable directly
// (buildLangEnv) so node tests can run the real service without a browser.
//
// The env contains:
//   /dts/*.d.ts      — declarations emitted from src/dsl.ts and its imports
//                      (the DSL's real types: Table, Expr, DSLSurface, …)
//   /globals.d.ts    — every DSLSurface property as an ambient global, exactly
//                      mirroring how the runtime injects the surface
//                      (new Function(...Object.keys(api), code) — runtime.ts)
//   /lib.*.d.ts      — the ES2022 standard-library closure from typescript/lib
//
// Enumerating DSLSurface with the type checker (rather than a hand-kept list)
// keeps the ambient globals in lockstep with dsl.ts: add a method to the
// surface and the editor knows it on the next build.

import ts from 'typescript'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = new URL('..', import.meta.url).pathname
const require = createRequire(import.meta.url)
const tsLibDir = path.dirname(require.resolve('typescript/lib/typescript.js'))

export const USER_FILE = '/main.js'
export const DEFAULT_LIB = '/lib.es2022.d.ts'

// Compiler options for the *user program* — mirrored by src/lang-service.ts.
// JS with checkJs off: completions and hover, no type-error noise on the
// untyped livecode programs.

export function buildLangEnv() {
  const dslEntry = path.join(root, 'src/dsl.ts')
  const program = ts.createProgram([dslEntry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
    skipLibCheck: true,
    strict: true,
    allowImportingTsExtensions: true,
    outDir: '/dts',
  })

  /** @type {Record<string, string>} */
  const files = {}
  const emit = program.emit(undefined, (fileName, text) => { files[fileName] = text })
  const diags = [...emit.diagnostics]
  if (diags.length) {
    const msgs = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')
    throw new Error(`gen-lang-env: declaration emit failed:\n${msgs}`)
  }
  if (!files['/dts/dsl.d.ts']) throw new Error('gen-lang-env: /dts/dsl.d.ts missing from emit')

  // Ambient globals: one const per DSLSurface property, typed by indexing into
  // the surface so overloads/doc-comments survive.
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(dslEntry)
  /** @type {string[]} */
  let surfaceProps = []
  sf.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'DSLSurface') {
      surfaceProps = checker.getTypeAtLocation(node.name).getProperties().map((p) => p.getName())
    }
  })
  if (!surfaceProps.length) throw new Error('gen-lang-env: DSLSurface has no properties — did dsl.ts change shape?')

  files['/globals.d.ts'] = [
    '// Generated — the DSL surface as ambient globals (see scripts/gen-lang-env.js).',
    'import type { DSLSurface } from "./dts/dsl.js";',
    'declare global {',
    ...surfaceProps.map((p) => `  const ${p}: DSLSurface[${JSON.stringify(p)}];`),
    // The programs run in a browser, but only console is worth offering from
    // the host environment — pulling in lib.dom would drown the DSL surface
    // in hundreds of irrelevant globals.
    '  const console: { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; debug(...args: unknown[]): void };',
    '}',
    'export {};',
  ].join('\n')

  // Standard-library closure: lib.es2022.d.ts plus everything it /// references.
  /** @param {string} name */
  const addLib = (name) => {
    const key = `/${name}`
    if (files[key] !== undefined) return
    const text = readFileSync(path.join(tsLibDir, name), 'utf8')
    files[key] = text
    for (const m of text.matchAll(/\/\/\/\s*<reference lib="([^"]+)"/g)) addLib(`lib.${m[1]}.d.ts`)
  }
  addLib('lib.es2022.d.ts')

  return { files, userFile: USER_FILE, defaultLib: DEFAULT_LIB, surfaceProps }
}

/** @param {string} outFile */
export function writeLangEnv(outFile) {
  const env = buildLangEnv()
  mkdirSync(path.dirname(outFile), { recursive: true })
  writeFileSync(outFile, JSON.stringify(env))
  return env
}

// CLI: node scripts/gen-lang-env.js [outFile]
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const out = process.argv[2] ?? path.join(root, 'public/assets/lang-env.json')
  const env = writeLangEnv(out)
  console.log(`lang-env: ${Object.keys(env.files).length} files, ${env.surfaceProps.length} DSL globals → ${out}`)
}
