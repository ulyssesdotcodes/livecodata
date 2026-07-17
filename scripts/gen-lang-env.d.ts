// Hand-written types for gen-lang-env.js, which stays plain JS so build.js
// can import it without a TS loader.
import type { LangEnv } from '../src/lang-service.js'

export declare const DEFAULT_LIB: string

export interface GeneratedLangEnv extends LangEnv {
  surfaceProps: string[]
}

export declare function buildLangEnv(): GeneratedLangEnv
export declare function writeLangEnv(outFile: string): GeneratedLangEnv
