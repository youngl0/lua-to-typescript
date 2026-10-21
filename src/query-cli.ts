import fs from "node:fs";
import path from "node:path";
import { openDependencyQuery } from "./dependency-query.js";
import type { FileDependencyResult } from "./query-types.js";

function usage(): string {
  return `Query Lua file dependencies

Usage:
  lua2ts query <file.lua> [--db file.json] [--transitive] [--json]

Options:
  --db <path>       Analysis database; relative file queries use its source root
                   Default: nearest ancestor lua-analysis.json of the input file
  --transitive      Follow indirect file dependencies as well (cycle-safe)
  --no-builtins     Hide Lua built-ins from the global list
  --json            Print only the structured JSON result
  -h, --help        Show this help

Global variables, module calls, and diagnostics always describe the selected file.
Query uses the saved snapshot. Run analyze again after changing sources.
`;
}

function findDatabase(file: string): string {
  let directory = path.dirname(path.resolve(file));
  while (true) {
    const candidate = path.join(directory, "lua-analysis.json");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("No lua-analysis.json found above the input file. Run analyze first or provide --db.");
}

function printResult(result: FileDependencyResult): void {
  console.log(`File: ${result.file}`);
  console.log(`Global dependencies (${result.globals.length}):`);
  for (const global of result.globals) {
    const providers = [...new Set(global.definitions.map((definition) => definition.file))];
    const positions = global.accesses.map((access) => `${access.access}@${access.line}:${access.column}`).join(", ");
    console.log(`  ${global.name} [${global.status}${global.definedInFile ? "; defined in this file" : ""}]${providers.length ? ` <- ${providers.join(", ")}` : ""}`);
    console.log(`    ${positions}`);
  }
  console.log(`File dependencies (${result.files.length}; ${result.transitive ? "transitive" : "direct"}):`);
  for (const file of result.files) {
    console.log(`  ${file.file} [${file.direct ? "direct" : "indirect"}; depth ${file.depth}]`);
    for (const reason of file.reasons) {
      console.log(`    ${reason.kind === "load" ? `load ${reason.loader}` : `global ${reason.symbol}`} @ ${reason.from}:${reason.line}:${reason.column}`);
    }
  }
  const unresolved = result.modules.filter((module) => module.status !== "resolved");
  console.log(`Unresolved module calls (${unresolved.length}):`);
  for (const module of unresolved) {
    console.log(`  ${module.loader}(${module.expression}) [${module.status}] @ ${module.line}:${module.column}`);
  }
  for (const diagnostic of result.diagnostics) {
    console.log(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code} @ ${diagnostic.line ?? "?"}:${diagnostic.column ?? "?"} ${diagnostic.message}`);
  }
}

export function runQuery(argv: string[]): number {
  try {
    let file: string | undefined;
    let database: string | undefined;
    let transitive = false;
    let includeBuiltins = true;
    let json = false;
    let help = false;
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "-h" || arg === "--help") help = true;
      else if (arg === "--transitive") transitive = true;
      else if (arg === "--no-builtins") includeBuiltins = false;
      else if (arg === "--json") json = true;
      else if (arg === "--db") {
        database = argv[++index];
        if (!database || database.startsWith("-")) throw new Error("Missing value for --db");
      } else if (arg.startsWith("-")) throw new Error(`Unknown query option: ${arg}`);
      else if (!file) file = arg;
      else throw new Error(`Unexpected argument: ${arg}`);
    }
    if (help || !file) {
      console.log(usage());
      return help ? 0 : 2;
    }
    // Without --db, input is relative to cwd for discovery; with --db it is relative to the source root.
    const queryFile = database ? file : path.resolve(file);
    const query = openDependencyQuery(database ?? findDatabase(queryFile));
    const result = query.getFileDependencies(queryFile, { transitive, includeBuiltins });
    if (json) console.log(JSON.stringify(result, null, 2));
    else printResult(result);
    return result.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
