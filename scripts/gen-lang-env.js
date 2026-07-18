#!/usr/bin/env node
// Build the editor language-service environment: the virtual file system the
// in-browser TypeScript language service (src/lang-service.ts) analyzes user
// programs against. The DSL and hydra surfaces are enumerated with the type
// checker rather than hand-kept lists, so the editor tracks dsl.ts / hydra-ts
// automatically. The two ambient-globals files describe different languages
// and must never share a program (env.langs gives each its own user file and
// roots).

import ts from 'typescript'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { defaultGenerators, defaultModifiers } from 'hydra-ts'

const root = new URL('..', import.meta.url).pathname
const require = createRequire(import.meta.url)
const tsLibDir = path.dirname(require.resolve('typescript/lib/typescript.js'))

export const DEFAULT_LIB = '/lib.es2022.d.ts'

// hydra-ts describes every generator and chain method as data ({ name, type,
// inputs }); render that into ambient declarations. Hydra's conventions: every
// argument is optional, floats also accept an array (cycled per frame) or a
// function of the per-frame props, and combine/combineCoord take the other
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

// The post chain surface, generated from src/post-lang.ts's POST_OPS registry
// (read straight from the source AST — data-driven, so it never drifts from the
// ops the engine actually compiles). fx/combine ops become PostChain methods;
// heads become globals. Their `doc` strings ride along as editor hover text.
/** @param {string} root */
function buildPostGlobals(root) {
  const src = readFileSync(path.join(root, 'src/post-lang.ts'), 'utf8')
  const sf = ts.createSourceFile('post-lang.ts', src, ts.ScriptTarget.ES2022, true)
  const unquote = (/** @type {string} */ s) => s.replace(/^['"`]|['"`]$/g, '')
  /** @param {ts.ObjectLiteralExpression} obj @param {string} key */
  const prop = (obj, key) => obj.properties.find((p) => ts.isPropertyAssignment(p) && unquote(p.name.getText(sf)) === key)?.initializer
  /** @type {{ name: string, kind: string, doc: string, args: { name: string, arg: string }[] }[]} */
  const ops = []
  sf.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'POST_OPS') continue
      if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue
      for (const p of decl.initializer.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.initializer)) continue
        const spec = p.initializer
        const kindNode = prop(spec, 'kind'); const docNode = prop(spec, 'doc'); const argsNode = prop(spec, 'args')
        const args = argsNode && ts.isArrayLiteralExpression(argsNode)
          ? argsNode.elements.filter(ts.isObjectLiteralExpression).map((a) => ({
              name: unquote((prop(a, 'name') ?? { getText: () => '' }).getText(sf)),
              arg: unquote((prop(a, 'arg') ?? { getText: () => '' }).getText(sf)),
            }))
          : []
        ops.push({
          name: unquote(p.name.getText(sf)),
          kind: kindNode ? unquote(kindNode.getText(sf)) : 'fx',
          doc: docNode ? unquote(docNode.getText(sf)) : '',
          args,
        })
      }
    }
  })
  if (!ops.length) throw new Error('gen-lang-env: POST_OPS not found in src/post-lang.ts')

  /** @param {{ name: string, arg: string }[]} args @param {boolean} combine */
  const params = (args, combine) => {
    const own = args.map((a) => `${a.name}?: ${a.arg === 'live' ? 'PostArg' : 'number'}`)
    return (combine ? ['other: PostChain', ...own] : own).join(', ')
  }
  /** @param {string} doc @param {string} indent */
  const docComment = (doc, indent) => (doc ? `${indent}/** ${doc.replace(/\*\//g, '*\\/')} */\n` : '')
  const fxOps = ops.filter((o) => o.kind === 'fx' || o.kind === 'combine')
  // Each op is both a PostChain method (chaining) and a top-level global (starts
  // a chain from the implicit scene) — so `edges(0.2)` and `blur(4).bloom(1)`
  // read like hydra.
  const methods = fxOps.map((o) => `${docComment(o.doc, '    ')}    ${o.name}(${params(o.args, o.kind === 'combine')}): PostChain;`).join('\n')
  const globals = fxOps.map((o) => `${docComment(o.doc, '  ')}  function ${o.name}(${params(o.args, o.kind === 'combine')}): PostChain;`).join('\n')

  return [
    "// Generated — the post chain surface, from src/post-lang.ts's op registry",
    '// (see scripts/gen-lang-env.js).',
    'declare global {',
    '  /** Per-frame values passed to function-valued (live) post arguments: your folded variables plus the playback clock. */',
    '  interface PostProps {',
    '    time: number;',
    '    beat: number;',
    '    bpm: number;',
    '    sliders?: Record<string, number>;',
    '    [variable: string]: unknown;',
    '  }',
    '  /** A live post argument: a constant, or a function of the per-frame props — e.g. edges((p) => p.th). */',
    '  type PostArg = number | ((p: PostProps) => number);',
    '  interface PostChain {',
    methods,
    '  }',
    globals,
    '  /** The raw rendered scene — needed only inside a branch arg, e.g. mask(scene()). */',
    '  function scene(): PostChain;',
    '  /** The previous output frame — one-frame-behind feedback, e.g. blend(prev(), 0.4). */',
    '  function prev(): PostChain;',
    '  /** A live on-screen slider as a live arg — blur(slider("r", 0, 8)) reads the slider each frame. Calling it also declares the control: one "sliders"-table row per name, the latest declaration winning min/max (default 0–1). */',
    '  function slider(name: string, min?: number, max?: number): (p: PostProps) => number;',
    '  /** A live post variable as a live arg — write it as var("name", initial): reads the folded variable each frame (the initial as fallback), and a "set" row for it materializes right after this cell — tweak or tween it there; deleting the var() call deletes the row. (`var` is a JS keyword, so tooling sees it as $vr.) */',
    '  function $vr(name: string, value?: number): (p: PostProps) => number;',
    '}',
    'export {};',
  ].join('\n')
}

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

  // One const per DSLSurface property, typed by indexing into the surface so
  // overloads survive; each member's JSDoc is copied onto the const because
  // the indexed-access type alone wouldn't carry it into editor hovers.
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

  // Only console from the host environment — pulling in lib.dom would drown
  // the DSL surface in hundreds of irrelevant globals.
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
  files['/post-globals.d.ts'] = buildPostGlobals(root).replace('declare global {', `declare global {\n${consoleDecl}`)

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
    // One language per kind of code cell; lang-service.ts builds a separate
    // program per language so the surfaces never bleed into each other.
    langs: {
      dsl: { userFile: '/main.js', roots: ['/globals.d.ts'] },
      hydra: { userFile: '/hydra-sketch.js', roots: ['/hydra-globals.d.ts'] },
      post: { userFile: '/post-sketch.js', roots: ['/post-globals.d.ts'] },
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
