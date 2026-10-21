import type { Diagnostic } from "./types.js";

export interface SourceLocation {
  line: number;
  column: number;
}

export interface GlobalAccess extends SourceLocation {
  name: string;
  access: "read" | "write" | "member-write";
  /** Fields belong to the global's table; they are not additional global variables. */
  memberPath?: string[];
}

export interface ModuleDependency extends SourceLocation {
  loader: string;
  expression: string;
  request?: string;
  status: "resolved" | "external" | "dynamic";
  target?: string;
}

export type AnalysisLuaVersion = "5.1" | "LuaJIT" | "5.2";

export interface FileAnalysis {
  hash: string;
  /** Successful analysis dialect. Absent on failed files or databases produced before analyzer v2. */
  parseMode?: AnalysisLuaVersion;
  globals: GlobalAccess[];
  modules: ModuleDependency[];
  diagnostics: Diagnostic[];
}

export interface GlobalSymbol {
  name: string;
  status: "defined" | "builtin" | "external";
  definitions: Array<SourceLocation & { file: string }>;
  references: Array<SourceLocation & { file: string; access: "read" | "member-write"; memberPath?: string[] }>;
}

export interface DependencyEdge extends SourceLocation {
  from: string;
  to: string;
  kind: "load" | "global";
  loader?: string;
  symbol?: string;
}

export interface AnalysisConfig {
  /** Global function names; custom loaders use require-style module paths. */
  loaders: string[];
  /** Ordered package.path-like templates, relative to the analyzed root. */
  modulePaths: string[];
}

export interface AnalysisDatabase {
  schemaVersion: 1;
  analyzerVersion: number;
  /** Fingerprint of the parser configuration used to build cached file records. */
  analysisKey: string;
  /** Relative to the database file, so the source and database can move together. */
  root: string;
  config: AnalysisConfig;
  files: Record<string, FileAnalysis>;
  globals: GlobalSymbol[];
  dependencies: DependencyEdge[];
  /** Reverse index of dependency edges, including potential global dependencies. */
  dependents: Record<string, string[]>;
  /** User-maintained metadata, preserved verbatim on every update/rebuild. */
  annotations: Record<string, unknown>;
}

export interface AnalyzeOptions {
  database?: string;
  rebuild?: boolean;
  loaders?: string[];
  modulePaths?: string[];
  /** Optional live progress; never saved to the database or included in the cache key. */
  onProgress?: (progress: AnalysisProgress) => void;
}

export interface AnalysisProgress {
  stage: "load" | "scan" | "files" | "resolve" | "index" | "write" | "done";
  /** Files processed so far. Percentages apply only during the files stage. */
  completed: number;
  /** During scanning this is the number discovered so far, not a final total. */
  total: number;
  parsed: number;
  reused: number;
  /** Current/most recently processed root-relative Lua file. */
  file?: string;
}

export interface AnalysisResult {
  database: AnalysisDatabase;
  databasePath: string;
  changes: { added: number; updated: number; reused: number; removed: number };
}
