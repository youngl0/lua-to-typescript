import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseAnalysisSource } from "./analysis-parser.js";
import { readAnalysisDatabase } from "./analysis-database.js";
import type { Diagnostic } from "./types.js";
import type {
  AnalysisConfig, AnalysisDatabase, AnalysisLuaVersion, AnalysisProgress, AnalysisResult, AnalyzeOptions, DependencyEdge,
  FileAnalysis, GlobalAccess, GlobalSymbol, ModuleDependency, SourceLocation,
} from "./analysis-types.js";

type Node = any;
const ANALYZER_VERSION = 2;
const DEFAULT_LOADERS = ["require", "dofile", "loadfile"];
const DEFAULT_MODULE_PATHS = ["?.lua", "?/init.lua"];
const BUILTINS = new Set([
  "_G", "_VERSION", "assert", "collectgarbage", "dofile", "error", "getfenv", "getmetatable",
  "ipairs", "load", "loadfile", "loadstring", "module", "next", "pairs", "pcall", "print",
  "rawequal", "rawget", "rawset", "require", "select", "setfenv", "setmetatable", "tonumber",
  "tostring", "type", "unpack", "xpcall", "coroutine", "debug", "io", "math", "os", "package",
  "string", "table", "newproxy",
]);
const slash = (value: string): string => value.replace(/\\/g, "/");
const pathKey = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
const location = (node: Node): SourceLocation => ({
  line: node.loc.start.line, column: node.loc.start.column + 1,
});

/** Decode literals without executing Lua. luaparse's default encoding leaves .value null. */
function staticString(node: Node): string | undefined {
  if (!node) return undefined;
  if (node.type === "BinaryExpression" && node.operator === "..") {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node.type !== "StringLiteral") return undefined;
  const raw: string = node.raw;
  if (raw.startsWith("[")) return raw.replace(/^\[=*\[\r?\n?/, "").replace(/\]=*\]$/, "");
  const escapes: Record<string, string> = {
    a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
    "\\": "\\", '"': '"', "'": "'",
  };
  return raw.slice(1, -1).replace(/\\(\r\n|\r|\n|\d{1,3}|.)/g, (_all, escaped: string) => {
    if (/^\d/.test(escaped)) return String.fromCharCode(Number(escaped));
    if (/^[\r\n]/.test(escaped)) return "\n";
    return escapes[escaped] ?? escaped;
  });
}

function globalIdentifier(node: Node, name?: string): boolean {
  return node?.type === "Identifier" && node.isLocal === false && (name === undefined || node.name === name);
}

function fieldName(node: Node): string | undefined {
  if (node.type === "MemberExpression") return node.identifier.name;
  return staticString(node.index);
}

function globalTable(node: Node): { name: string; fields: string[] } | undefined {
  if (globalIdentifier(node)) return { name: node.name, fields: [] };
  if (node?.type !== "MemberExpression" && node?.type !== "IndexExpression") return undefined;
  const base = globalTable(node.base);
  const field = fieldName(node);
  if (!base || field === undefined) return undefined;
  if (base.name === "_G" && base.fields.length === 0) return { name: field, fields: [] };
  return { name: base.name, fields: [...base.fields, field] };
}

function globalFunctionName(node: Node): string | undefined {
  if (node?.type === "MemberExpression" && node.indexer === ":") return undefined;
  const target = globalTable(node);
  return target ? [target.name, ...target.fields].join(".") : undefined;
}

export function analyzeLua(source: string, loaders: string[] = DEFAULT_LOADERS): Omit<FileAnalysis, "hash"> {
  let parseMode: AnalysisLuaVersion | undefined;
  const globals: GlobalAccess[] = [];
  const modules: ModuleDependency[] = [];
  const diagnostics: Diagnostic[] = [];
  const report = (node: Node, code: string, message: string): void => {
    diagnostics.push({ severity: "warning", code, message, ...location(node) });
  };
  const record = (node: Node, name: string, access: GlobalAccess["access"], fields: string[] = []): void => {
    globals.push({ name, access, ...location(node), ...(fields.length ? { memberPath: fields } : {}) });
  };

  function access(node: Node, write: boolean): void {
    if (globalIdentifier(node)) {
      record(node, node.name, write ? "write" : "read");
      return;
    }
    if (node.type === "MemberExpression" || node.type === "IndexExpression") {
      const target = globalTable(node);
      if (target) {
        record(node, target.name, write ? (target.fields.length ? "member-write" : "write") : "read", target.fields);
        return;
      }
      if (globalIdentifier(node.base, "_G")) {
        report(node, "LUA_ANALYSIS_DYNAMIC_GLOBAL", "Computed _G key cannot be resolved statically.");
      }
      // Even a computed member write reads the table and index; it never reassigns the global table.
      walk(node.base);
      if (node.type === "IndexExpression") walk(node.index);
    }
  }

  function call(node: Node): void {
    const name = globalFunctionName(node.base);
    const args: Node[] = node.type === "StringCallExpression" ? [node.argument]
      : node.type === "TableCallExpression" ? [node.arguments] : node.arguments;
    const protectedLoader = name === "pcall" ? globalFunctionName(args[0]) : undefined;
    const loader = name && loaders.includes(name) ? name
      : protectedLoader && loaders.includes(protectedLoader) ? protectedLoader : undefined;
    if (loader) {
      const argument = args[name === "pcall" ? 1 : 0];
      const request = staticString(argument);
      modules.push({
        loader, expression: argument ? source.slice(argument.range[0], argument.range[1]) : "",
        ...location(node), ...(request === undefined ? {} : { request }),
        status: request === undefined ? "dynamic" : "external",
      });
      if (request === undefined) report(node, "LUA_ANALYSIS_DYNAMIC_DEPENDENCY", `${loader}() path cannot be resolved statically.`);
    }
    if (name === "setfenv" || name === "module" || name === "loadstring" || name === "load") {
      report(node, "LUA_ANALYSIS_DYNAMIC_ENVIRONMENT", `${name}() can change globals or execute code unavailable to static analysis.`);
    }
    if ((name === "rawget" || name === "rawset") && globalIdentifier(args[0], "_G")) {
      const key = staticString(args[1]);
      if (key !== undefined) record(node, key, name === "rawset" ? "write" : "read");
      else report(node, "LUA_ANALYSIS_DYNAMIC_GLOBAL", `${name}(_G, ...) key cannot be resolved statically.`);
    }
    if (name) access(node.base, false);
    else walk(node.base);
    args.forEach((argument, index) => {
      if (name === "pcall" && protectedLoader && loaders.includes(protectedLoader) && index === 0) access(argument, false);
      else walk(argument);
    });
  }

  function walk(node: Node): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    switch (node.type) {
      case "Identifier":
        access(node, false);
        if (globalIdentifier(node) && loaders.includes(node.name)) {
          report(node, "LUA_ANALYSIS_LOADER_REFERENCE", "Loader used as a value; indirect calls through aliases are not resolved.");
        }
        return;
      case "MemberExpression": case "IndexExpression": {
        access(node, false);
        const name = globalFunctionName(node);
        if (name && loaders.includes(name)) {
          report(node, "LUA_ANALYSIS_LOADER_REFERENCE", "Loader used as a value; indirect calls through aliases are not resolved.");
        }
        return;
      }
      case "AssignmentStatement":
        node.variables.forEach((variable: Node) => access(variable, true));
        node.init.forEach(walk);
        return;
      case "LocalStatement": node.init.forEach(walk); return;
      case "FunctionDeclaration":
        if (node.identifier && !node.isLocal) access(node.identifier, true);
        walk(node.body);
        return;
      case "TableKeyString": walk(node.value); return;
      case "CallExpression": case "StringCallExpression": case "TableCallExpression": call(node); return;
      default:
        for (const [key, value] of Object.entries(node)) {
          if (!["loc", "range", "comments", "globals"].includes(key)) walk(value);
        }
    }
  }

  try {
    const parsed = parseAnalysisSource(source);
    walk(parsed.ast.body);
    parseMode = parsed.parseMode;
    if (parseMode !== "5.1") {
      diagnostics.push({ severity: "info", code: "LUA_ANALYSIS_COMPATIBILITY_MODE",
        message: `Analyzed original source using ${parseMode} compatibility mode; source text and locations are unchanged.` });
    }
  } catch (error) {
    const failure = error as { message?: string; line?: number; column?: number };
    // Never retain a partial file index after a parse/analysis error.
    globals.length = 0;
    modules.length = 0;
    diagnostics.push({ severity: "error", code: "LUA_ANALYSIS_PARSE_ERROR", message: failure.message ?? String(error),
      line: failure.line, column: failure.column === undefined ? undefined : failure.column + 1 });
  }
  globals.sort((a, b) => a.line - b.line || a.column - b.column || a.name.localeCompare(b.name));
  return { ...(parseMode === undefined ? {} : { parseMode }), globals, modules, diagnostics };
}

function collectFiles(root: string, onFile?: (file: string, count: number) => void): string[] {
  const files: string[] = [];
  function collect(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", ".svn", "node_modules"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      // Symlinks are intentionally not followed: avoid cycles and escaping the analyzed root.
      if (entry.isDirectory()) collect(absolute);
      else if (entry.isFile() && /\.lua$/i.test(entry.name)) {
        files.push(absolute);
        onFile?.(slash(path.relative(root, absolute)), files.length);
      }
    }
  }
  collect(root);
  return files;
}

function resolveModules(files: Record<string, FileAnalysis>, root: string, config: AnalysisConfig): void {
  const fileNames = new Map(Object.keys(files).map((file) => [pathKey(file), file]));
  for (const record of Object.values(files)) {
    for (const dependency of record.modules) {
      delete dependency.target;
      if (dependency.request === undefined) { dependency.status = "dynamic"; continue; }
      const request = slash(dependency.request);
      const candidates = dependency.loader === "dofile" || dependency.loader === "loadfile"
        ? [request]
        : config.modulePaths.map((template) => template.replace(/\?/g, request.replace(/\./g, "/")));
      dependency.status = "external";
      for (const candidate of candidates) {
        const relative = slash(path.relative(root, path.resolve(root, candidate)));
        const target = fileNames.get(pathKey(relative));
        if (target !== undefined) {
          dependency.target = target;
          dependency.status = "resolved";
          break;
        }
      }
    }
  }
}

function buildIndexes(files: Record<string, FileAnalysis>): Pick<AnalysisDatabase, "globals" | "dependencies" | "dependents"> {
  const symbols = new Map<string, GlobalSymbol>();
  const dependencies: DependencyEdge[] = [];
  for (const [file, record] of Object.entries(files)) {
    for (const item of record.globals) {
      let symbol = symbols.get(item.name);
      if (!symbol) {
        symbol = { name: item.name, status: BUILTINS.has(item.name) ? "builtin" : "external", definitions: [], references: [] };
        symbols.set(item.name, symbol);
      }
      const at = { file, line: item.line, column: item.column };
      if (item.access === "write") {
        symbol.definitions.push(at);
        symbol.status = "defined";
      } else symbol.references.push({ ...at, access: item.access, ...(item.memberPath ? { memberPath: item.memberPath } : {}) });
    }
    for (const item of record.modules) {
      if (item.target) dependencies.push({ from: file, to: item.target, kind: "load", loader: item.loader, line: item.line, column: item.column });
    }
  }
  const globals = [...symbols.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const symbol of globals) {
    const providers = [...new Set(symbol.definitions.map((definition) => definition.file))];
    for (const reference of symbol.references) {
      for (const provider of providers) {
        if (provider !== reference.file) dependencies.push({ from: reference.file, to: provider, kind: "global", symbol: symbol.name,
          line: reference.line, column: reference.column });
      }
    }
  }
  dependencies.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind));
  const dependents: Record<string, string[]> = Object.fromEntries(Object.keys(files).map((file) => [file, []]));
  for (const edge of dependencies) {
    if (!dependents[edge.to].includes(edge.from)) dependents[edge.to].push(edge.from);
  }
  Object.values(dependents).forEach((values) => values.sort());
  return { globals, dependencies, dependents };
}

export function analyzeDirectory(directory: string, options: AnalyzeOptions = {}): AnalysisResult {
  const root = path.resolve(directory);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Analysis input must be a directory: ${root}`);
  const databasePath = path.resolve(options.database ?? path.join(root, "lua-analysis.json"));
  if (/\.lua$/i.test(databasePath)) throw new Error("Database path must not overwrite a Lua source file.");
  const changes = { added: 0, updated: 0, reused: 0, removed: 0 };
  let completed = 0;
  let total = 0;
  const progress = (stage: AnalysisProgress["stage"], file?: string): void => {
    options.onProgress?.({ stage, completed, total, parsed: changes.added + changes.updated, reused: changes.reused,
      ...(file === undefined ? {} : { file }) });
  };
  progress("load");
  const previous = fs.existsSync(databasePath) ? readAnalysisDatabase(databasePath) : undefined;
  if (previous && pathKey(path.resolve(path.dirname(databasePath), previous.root)) !== pathKey(root)) {
    throw new Error("Database belongs to a different source directory. Use a new --db path.");
  }
  const config: AnalysisConfig = {
    loaders: [...new Set([...DEFAULT_LOADERS, ...(options.loaders ?? previous?.config.loaders ?? [])])].sort(),
    modulePaths: options.modulePaths ?? previous?.config.modulePaths ?? DEFAULT_MODULE_PATHS,
  };
  if (config.loaders.some((loader) => !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(loader))) throw new Error("Loader names must be global function names, e.g. import or utils.import.");
  if (!config.modulePaths.length || config.modulePaths.some((template) => !template.includes("?"))) throw new Error("Each module path must contain a ? placeholder.");
  const analysisKey = createHash("sha256").update(JSON.stringify({ analyzerVersion: ANALYZER_VERSION, config })).digest("hex");
  const reuse = !options.rebuild && previous?.analyzerVersion === ANALYZER_VERSION && previous.analysisKey === analysisKey;
  const files: Record<string, FileAnalysis> = Object.create(null);
  progress("scan");
  const inputs = collectFiles(root, options.onProgress ? (file, count) => {
    total = count;
    progress("scan", file);
  } : undefined);
  total = inputs.length;
  progress("files", inputs[0] ? slash(path.relative(root, inputs[0])) : undefined);
  for (const absolute of inputs) {
    const relative = slash(path.relative(root, absolute));
    progress("files", relative);
    if (absolute === databasePath) throw new Error("Database path overlaps an input source file.");
    const content = fs.readFileSync(absolute);
    const hash = createHash("sha256").update(content).digest("hex");
    const prior = previous?.files[relative];
    if (reuse && prior?.hash === hash) {
      files[relative] = structuredClone(prior);
      changes.reused += 1;
    } else {
      files[relative] = { hash, ...analyzeLua(content.toString("utf8"), config.loaders) };
      if (prior) changes.updated += 1;
      else changes.added += 1;
    }
    completed += 1;
    progress("files", relative);
  }
  changes.removed = Object.keys(previous?.files ?? {}).filter((file) => !Object.hasOwn(files, file)).length;
  progress("resolve");
  resolveModules(files, root, config);
  progress("index");
  const database: AnalysisDatabase = {
    schemaVersion: 1, analyzerVersion: ANALYZER_VERSION, analysisKey,
    root: slash(path.relative(path.dirname(databasePath), root)) || ".", config,
    files, ...buildIndexes(files), annotations: previous?.annotations ?? {},
  };
  progress("write");
  const serialized = `${JSON.stringify(database, null, 2)}\n`;
  // Stable output avoids meaningless diffs; replacement is atomic and never truncates the prior database.
  if (!fs.existsSync(databasePath) || fs.readFileSync(databasePath, "utf8") !== serialized) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const temporary = `${databasePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temporary, databasePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  progress("done");
  return { database, databasePath, changes };
}
