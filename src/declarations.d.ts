// CSS module stub — esbuild handles CSS; TypeScript only needs the import to resolve.
declare module '*.css' {
  const content: string
  export default content
}

// jolt-physics ships no TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module 'jolt-physics' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type JoltModule = any
  export default function initJolt(): Promise<JoltModule>
}

// hydra-synth ships no TypeScript declarations. The synth surface is fully
// dynamic (transform functions generated at runtime), so it's typed as any.
declare module 'hydra-synth' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Hydra: any
  export default Hydra
}
