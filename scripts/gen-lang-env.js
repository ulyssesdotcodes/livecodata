#!/usr/bin/env node
// Build the editor language-service environment: the virtual file system the
// in-browser TypeScript language service (src/lang-service.ts) analyzes user
// programs against. Written as JSON to public/assets/lang-env.json by
// build.js/watch.js so the lang worker can fetch it, and importable directly
// (buildLangEnv) so node tests can run the real service without a browser.
//
// The env contains:
//   /dts/*.d.ts           — declarations emitted from src/dsl.ts and its
//                           imports (the DSL's real types: Table, Expr, …)
//   /globals.d.ts         — every DSLSurface property as an ambient global,
//                           exactly mirroring how the runtime injects the
//                           surface (new Function(...keys, code) — runtime.ts)
//   /hydra-globals.d.ts   — the hydra sketch surface (osc, src, chain methods,
//                           s0…/o0…), generated from hydra-ts's transform
//                           definition tables — hydra-ts builds those methods
//                           at runtime, so its shipped .d.ts carries no names
//                           or parameters; the definitions do
//   /lib.*.d.ts           — the ES2022 standard-library closure
//
// The two ambient-globals files describe different languages (the program vs a
// hydra sketch cell), so they must never share a program: env.langs gives each
// its user file and root set, and lang-service.ts builds one service per lang.
//
// Enumerating DSLSurface with the type checker (rather than a hand-kept list)
// keeps the ambient globals in lockstep with dsl.ts: add a method to the
// surface and the editor knows it on the next build. Same for hydra: the
// generated surface tracks whatever transforms the installed hydra-ts defines.

import ts from 'typescript'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { defaultGenerators, defaultModifiers } from 'hydra-ts'

const root = new URL('..', import.meta.url).pathname
const require = createRequire(import.meta.url)
const tsLibDir = path.dirname(require.resolve('typescript/lib/typescript.js'))

export const DEFAULT_LIB = '/lib.es2022.d.ts'

// ── hydra sketch surface ─────────────────────────────────────────────────────
// hydra-ts describes every generator (osc, noise, …) and chain method
// (modulate, kaleid, …) as data: { name, type, inputs: [{ name, type,
// default }] }. Render that into ambient declarations. Signature conventions
// follow hydra: every argument is optional (defaults apply), floats also
// accept an array (cycled per frame) or a function of the per-frame props
// ("dynamic" arguments), and the combine/combineCoord methods take the other
// texture first.

/** @param {{ type: string, default?: unknown }} input */
const hydraParamType = (input) =>
  input.type === 'sampler2D' ? 'HydraTexture'
    : input.type === 'vec4' ? 'HydraNum | string'
      : 'HydraNum'

/** @param {{ name: string, type: string, inputs: readonly { name: string, type: string, default?: unknown }[] }} t */
const hydraParams = (t) => {
  const params = t.inputs.map((i) => `${i.name}?: ${hydraParamType(i)}`)
  if (t.type === 'combine' || t.type === 'combineCoord') params.unshift('texture: HydraTexture')
  return params.join(', ')
}

/**
 * @param {{ name: string, type: string, inputs: readonly { name: string, type: string, default?: unknown }[] }} t
 * @param {string} indent
 */
const hydraDoc = (t, indent) => {
  const defaults = t.inputs
    .filter((i) => typeof i.default === 'number' || typeof i.default === 'string' || Array.isArray(i.default))
    .map((i) => `${i.name} ${JSON.stringify(i.default)}`)
    .join(', ')
  return `${indent}/** hydra ${t.type}${defaults ? ` — defaults: ${defaults}` : ''} */`
}

function buildHydraGlobals() {
  const chainMethods = defaultModifiers.flatMap((t) => [
    hydraDoc(t, '    '),
    `    ${t.name}(${hydraParams(t)}): HydraChain;`,
  ])
  const generators = defaultGenerators.flatMap((t) => [
    hydraDoc(t, '  '),
    `  function ${t.name}(${hydraParams(t)}): HydraChain;`,
  ])
  return [
    '// Generated — the hydra sketch surface, from hydra-ts\'s transform',
    '// definitions (see scripts/gen-lang-env.js).',
    'declare global {',
    '  /** Per-frame values passed to function-valued ("dynamic") arguments: hydra\'s own clock fields plus any setVariable rows in scope. */',
    '  interface HydraProps {',
    '    time: number;',
    '    bpm: number;',
    '    fps?: number;',
    '    resolution: readonly [number, number];',
    '    speed: number;',
    '    stats: { fps: number };',
    '    [variable: string]: unknown;',
    '  }',
    '  /** A numeric hydra argument: a constant, an array cycled per frame, or a function of the per-frame props — e.g. osc((props) => props.freq). */',
    '  type HydraNum = number | number[] | ((props: HydraProps) => number | number[]);',
    '  /** An external source texture (s0 is the rendered Three.js scene). */',
    '  interface HydraSource { readonly __kind: "source" }',
    '  /** A render target (o0 is the visible canvas). */',
    '  interface HydraOutput { readonly __kind: "output" }',
    '  /** Anything usable as a texture argument: another chain, a source, or an output. */',
    '  type HydraTexture = HydraChain | HydraSource | HydraOutput;',
    '  interface HydraChain {',
    '    /** Render this chain to an output (default o0, the visible canvas). */',
    '    out(output?: HydraOutput): void;',
    ...chainMethods,
    '  }',
    ...generators,
    ...[0, 1, 2, 3].map((i) => `  const s${i}: HydraSource;`),
    ...[0, 1, 2, 3].map((i) => `  const o${i}: HydraOutput;`),
    '}',
    'export {};',
  ].join('\n')
}

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
  // the surface so overloads survive — and each member's JSDoc copied onto the
  // generated const, so hovering the bare global in the editor shows the doc
  // (the indexed-access type alone wouldn't carry it).
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(dslEntry)
  /** @type {{ name: string, doc: string }[]} */
  let surface = []
  sf.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'DSLSurface') {
      surface = checker.getTypeAtLocation(node.name).getProperties().map((p) => ({
        name: p.getName(),
        doc: ts.displayPartsToString(p.getDocumentationComment(checker)),
      }))
    }
  })
  if (!surface.length) throw new Error('gen-lang-env: DSLSurface has no properties — did dsl.ts change shape?')
  const surfaceProps = surface.map((p) => p.name)

  /** @param {string} doc */
  const jsdocLines = (doc) =>
    doc ? [`  /** ${doc.replace(/\*\//g, '*\\/').split('\n').join('\n   * ')} */`] : []

  // The programs run in a browser, but only console is worth offering from
  // the host environment — pulling in lib.dom would drown the DSL surface
  // in hundreds of irrelevant globals.
  const consoleDecl = '  const console: { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; debug(...args: unknown[]): void };'

  files['/globals.d.ts'] = [
    '// Generated — the DSL surface as ambient globals (see scripts/gen-lang-env.js).',
    'import type { DSLSurface } from "./dts/dsl.js";',
    'declare global {',
    ...surface.flatMap(({ name, doc }) => [
      ...jsdocLines(doc),
      `  const ${name}: DSLSurface[${JSON.stringify(name)}];`,
    ]),
    consoleDecl,
    '}',
    'export {};',
  ].join('\n')

  files['/hydra-globals.d.ts'] = buildHydraGlobals().replace('declare global {', `declare global {\n${consoleDecl}`)

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

  return {
    files,
    defaultLib: DEFAULT_LIB,
    // One language per kind of code cell the editor opens: the main program
    // (DSL) and hydra sketch cells. Each pairs a user file with the ambient
    // globals that describe its surface; lang-service.ts builds a separate
    // program per language so the surfaces never bleed into each other.
    langs: {
      dsl: { userFile: '/main.js', roots: ['/globals.d.ts'] },
      hydra: { userFile: '/hydra-sketch.js', roots: ['/hydra-globals.d.ts'] },
    },
    surfaceProps,
  }
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
