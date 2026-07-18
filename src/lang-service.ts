// The editor's TypeScript language service: the real TS service stood up over
// a virtual file system (declarations + libs from scripts/gen-lang-env.js).
// No DOM or Worker APIs — the browser runs it inside lang-worker.ts; node
// tests call it directly. Every query ships the full program text: programs
// are small, so that beats an incremental sync protocol, and the service
// reuses its program when the text is unchanged.

import ts from 'typescript'

// Each language gets its own service program — the ambient surfaces must never
// see each other.
export type EditorLang = 'dsl' | 'hydra' | 'post'

export interface LangEnv {
  files: Record<string, string>
  defaultLib: string
  langs: Record<EditorLang, { userFile: string; roots: string[] }>
}

export interface LangCompletionEntry {
  name: string
  kind: string // a ts.ScriptElementKind: 'method' | 'const' | 'keyword' | …
  sortText: string
}

export interface LangCompletions {
  entries: LangCompletionEntry[]
  isMemberCompletion: boolean
}

// One resolved symbol — a completion's details or a hover target. `display` is
// TS's full rendering, e.g. "(method) Table.map(fn: …): Table (+1 overload)".
export interface LangSymbolInfo {
  display: string
  docs: string
  kind: string
  start: number
  end: number
}

export interface LangSignature {
  prefix: string
  suffix: string
  separator: string
  params: { label: string; docs: string }[]
  docs: string
}

export interface LangSignatureHelp {
  signatures: LangSignature[]
  activeSignature: number
  activeParameter: number
  // Right after the open paren — the tooltip anchors here so it doesn't jump
  // as arguments are typed.
  argumentStart: number
}

export interface LangService {
  completionsAt(text: string, pos: number): LangCompletions | null
  detailsAt(text: string, pos: number, name: string): LangSymbolInfo | null
  quickInfoAt(text: string, pos: number): LangSymbolInfo | null
  signatureHelpAt(text: string, pos: number, triggerChar?: string): LangSignatureHelp | null
}

const partsToString = (parts: ts.SymbolDisplayPart[] | undefined): string =>
  parts ? ts.displayPartsToString(parts) : ''

const docsOf = (doc: ts.SymbolDisplayPart[] | undefined, tags: ts.JSDocTagInfo[] | undefined): string => {
  const body = partsToString(doc)
  const tagText = (tags ?? [])
    .map((t) => `@${t.name}${t.text ? ' ' + partsToString(t.text) : ''}`)
    .join('\n')
  return [body, tagText].filter(Boolean).join('\n')
}

export function createLangService(env: LangEnv, lang: EditorLang = 'dsl'): LangService {
  const { userFile, roots } = env.langs[lang]
  let userText = ''
  let version = 0

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    allowNonTsExtensions: true,
  }

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [userFile, ...roots],
    getScriptVersion: (f) => (f === userFile ? String(version) : '1'),
    getScriptSnapshot: (f) => {
      const text = f === userFile ? userText : env.files[f]
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => env.defaultLib,
    fileExists: (f) => f === userFile || env.files[f] !== undefined,
    readFile: (f) => (f === userFile ? userText : env.files[f]),
    directoryExists: () => true,
    getDirectories: () => [],
  }

  const ls = ts.createLanguageService(host)

  const sync = (text: string): void => {
    if (text === userText && version > 0) return
    userText = text
    version++
  }

  return {
    completionsAt(text, pos) {
      sync(text)
      const res = ls.getCompletionsAtPosition(userFile, pos, {
        includeCompletionsForModuleExports: false,
        includeCompletionsForImportStatements: false,
        includeCompletionsWithSnippetText: false,
        includeCompletionsWithInsertText: false,
      })
      if (!res) return null
      const entries = res.entries
        // Drop the DSL's own plumbing (_-prefixed) and anything TS wants to
        // rewrite on insert.
        .filter((e) => !e.name.startsWith('_') && !e.insertText)
        .map((e) => ({ name: e.name, kind: String(e.kind), sortText: e.sortText }))
      return { entries, isMemberCompletion: Boolean(res.isMemberCompletion) }
    },

    detailsAt(text, pos, name) {
      sync(text)
      const d = ls.getCompletionEntryDetails(userFile, pos, name, undefined, undefined, undefined, undefined)
      if (!d) return null
      return {
        display: partsToString(d.displayParts),
        docs: docsOf(d.documentation, d.tags),
        kind: String(d.kind),
        start: pos,
        end: pos,
      }
    },

    quickInfoAt(text, pos) {
      sync(text)
      const qi = ls.getQuickInfoAtPosition(userFile, pos)
      if (!qi) return null
      return {
        display: partsToString(qi.displayParts),
        docs: docsOf(qi.documentation, qi.tags),
        kind: String(qi.kind),
        start: qi.textSpan.start,
        end: qi.textSpan.start + qi.textSpan.length,
      }
    },

    signatureHelpAt(text, pos, triggerChar) {
      sync(text)
      const reason: ts.SignatureHelpTriggerReason | undefined =
        triggerChar === '(' || triggerChar === ','
          ? { kind: 'characterTyped', triggerCharacter: triggerChar }
          : { kind: 'invoked' }
      const sh = ls.getSignatureHelpItems(userFile, pos, { triggerReason: reason })
      if (!sh) return null
      return {
        signatures: sh.items.map((item) => ({
          prefix: partsToString(item.prefixDisplayParts),
          suffix: partsToString(item.suffixDisplayParts),
          separator: partsToString(item.separatorDisplayParts),
          params: item.parameters.map((p) => ({
            label: partsToString(p.displayParts),
            docs: partsToString(p.documentation),
          })),
          docs: partsToString(item.documentation),
        })),
        activeSignature: sh.selectedItemIndex,
        activeParameter: sh.argumentIndex,
        argumentStart: sh.applicableSpan.start,
      }
    },
  }
}
