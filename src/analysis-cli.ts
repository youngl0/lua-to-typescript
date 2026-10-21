import { analyzeDirectory } from "./analyzer.js";
import type { AnalysisResult, AnalyzeOptions } from "./analysis-types.js";
import { AnalysisProgressDisplay } from "./analysis-progress.js";

function usage(): string {
  return `Lua directory analysis

Usage:
  lua2ts analyze <directory> [--db file.json] [--rebuild]

Options:
  --db <path>              Database file (default: <directory>/lua-analysis.json)
  --loader <global-name>   Additional require-style loader; repeatable
  --module-path <template> Ordered root-relative search template; repeatable
                          Default: ?.lua, ?/init.lua
  --rebuild                Reparse every file; preserve annotations
  --progress               Show progress even when stderr is redirected
  --no-progress            Disable progress (default: on for terminals only)
  -h, --help               Show this help

Run the same command again to update the database incrementally.
`;
}

export function runAnalysis(argv: string[]): number {
  try {
    const options: AnalyzeOptions = {};
    let directory: string | undefined;
    let help = false;
    let showProgress = Boolean(process.stderr.isTTY);
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "-h" || arg === "--help") help = true;
      else if (arg === "--rebuild") options.rebuild = true;
      else if (arg === "--progress") showProgress = true;
      else if (arg === "--no-progress") showProgress = false;
      else if (["--db", "--loader", "--module-path"].includes(arg)) {
        const value = argv[++index];
        if (!value || value.startsWith("-")) throw new Error(`Missing value for ${arg}`);
        if (arg === "--db") options.database = value;
        else if (arg === "--loader") (options.loaders ??= []).push(value);
        else (options.modulePaths ??= []).push(value);
      } else if (arg.startsWith("-")) throw new Error(`Unknown analysis option: ${arg}`);
      else if (!directory) directory = arg;
      else throw new Error(`Unexpected argument: ${arg}`);
    }
    if (help || !directory) {
      console.log(usage());
      return help ? 0 : 2;
    }
    const progress = new AnalysisProgressDisplay(process.stderr, showProgress);
    if (showProgress) options.onProgress = (event) => progress.update(event);
    let result: AnalysisResult;
    try {
      result = analyzeDirectory(directory, options);
    } finally {
      progress.stop();
    }
    const { database, changes } = result;
    let errors = 0;
    let warnings = 0;
    let compatibility = 0;
    for (const [file, record] of Object.entries(database.files)) {
      if (record.parseMode && record.parseMode !== "5.1") compatibility += 1;
      for (const diagnostic of record.diagnostics) {
        if (diagnostic.severity === "error") errors += 1;
        if (diagnostic.severity === "warning") warnings += 1;
        console.log(`${file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ""} ${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.message}`);
      }
    }
    console.log(`Database: ${result.databasePath}`);
    console.log(`Analyzed ${Object.keys(database.files).length} Lua file(s), ${database.globals.length} global symbol(s), ${database.dependencies.length} dependency edge(s).`);
    console.log(`Files: ${changes.added} added, ${changes.updated} updated, ${changes.reused} reused, ${changes.removed} removed.`);
    const modules = Object.values(database.files).flatMap((file) => file.modules);
    console.log(`Modules: ${modules.filter((item) => item.status === "resolved").length} resolved, ${modules.filter((item) => item.status === "external").length} external/unresolved, ${modules.filter((item) => item.status === "dynamic").length} dynamic.`);
    console.log(`Diagnostics: ${errors} errors, ${warnings} warnings.`);
    if (compatibility) console.log(`Compatibility: ${compatibility} file(s) analyzed using LuaJIT/Lua 5.2; see files[].parseMode.`);
    return errors ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
