// bauble-runtime ships types at its package root, but its package.json
// "exports" has no "types" condition, so TypeScript can't see them. This
// mirrors its index.d.ts (an emscripten factory around bauble.studio's
// Janet→GLSL compiler).
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

  // Overrides may replace any Module hook; these two capture the compiler's
  // stdout/stderr chatter.
  const baubleFactory: (overrides?: {
    print?: (line: string) => void
    printErr?: (line: string) => void
  }) => Promise<BaubleModule>
  export default baubleFactory
}
