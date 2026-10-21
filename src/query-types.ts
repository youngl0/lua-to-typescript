import type { DependencyEdge, GlobalAccess, GlobalSymbol, ModuleDependency } from "./analysis-types.js";
import type { Diagnostic } from "./types.js";

export interface DependencyQueryOptions {
  /** Follow both load edges and potential cross-file global edges; default false. */
  transitive?: boolean;
  /** Include observed Lua built-ins in global dependencies; default true. */
  includeBuiltins?: boolean;
}

export interface GlobalDependency {
  name: string;
  status: GlobalSymbol["status"];
  definedInFile: boolean;
  /** All known definitions, including multiple candidate provider files. */
  definitions: GlobalSymbol["definitions"];
  /** Only reads/member mutations in the selected file; pure definitions are excluded. */
  accesses: GlobalAccess[];
}

export interface FileDependency {
  file: string;
  /** Minimum number of edges from the selected file. */
  depth: number;
  direct: boolean;
  /** Source positions and load/global reasons, including alternative paths. */
  reasons: DependencyEdge[];
}

export interface FileDependencyResult {
  file: string;
  transitive: boolean;
  globals: GlobalDependency[];
  files: FileDependency[];
  /** All loader calls in the selected file, including external/dynamic requests. */
  modules: ModuleDependency[];
  /** Diagnostics are retained so an incomplete source analysis is visible to callers. */
  diagnostics: Diagnostic[];
}
