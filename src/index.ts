export { convertLua } from "./converter.js";
export { RUNTIME_FILE_NAME, RUNTIME_SOURCE } from "./runtime-source.js";
export type { ConversionMode, ConvertOptions, ConvertResult, Diagnostic } from "./types.js";
export { analyzeLua, analyzeDirectory } from "./analyzer.js";
export { readAnalysisDatabase } from "./analysis-database.js";
export { DependencyQuery, openDependencyQuery } from "./dependency-query.js";
export type { DependencyQueryOptions, FileDependencyResult, GlobalDependency, FileDependency } from "./query-types.js";
export type {
  AnalysisDatabase, AnalysisConfig, AnalyzeOptions, AnalysisResult, AnalysisProgress, AnalysisLuaVersion,
  FileAnalysis, GlobalAccess, GlobalSymbol, ModuleDependency, DependencyEdge, SourceLocation,
} from "./analysis-types.js";
