// Hand-written types for gen-lang-env.js (plain node JS so build.js can
// import it without a TS loader) — lets typechecked tests import the builder.
import type { LangEnv } from '../src/lang-service.js'

export declare const USER_FILE: string
export declare const DEFAULT_LIB: string

export interface GeneratedLangEnv extends LangEnv {
  surfaceProps: string[]
}

export declare function buildLangEnv(): GeneratedLangEnv
export declare function writeLangEnv(outFile: string): GeneratedLangEnv
