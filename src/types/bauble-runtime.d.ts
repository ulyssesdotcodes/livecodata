// bauble-runtime ships types at its package root (index.d.ts), but its
// package.json "exports" points straight at build/wasm.js with no "types"
// condition, so TypeScript can't see them. This mirrors that index.d.ts
// (an emscripten module factory around bauble.studio's Janet→GLSL compiler).
declare module 'bauble-runtime' {
  export interface EvaluationResult {
    isError: boolean
    shaderSource: string
    isAnimated: boolean
    error: string
  }

  export interface BaubleModule {
    evaluate_script: (script: string) => EvaluationResult
  }

  // The emscripten factory: overrides may replace any Module hook — the two
  // used here capture the compiler's stdout/stderr chatter.
  const baubleFactory: (overrides?: {
    print?: (line: string) => void
    printErr?: (line: string) => void
  }) => Promise<BaubleModule>
  export default baubleFactory
}
