import path from "node:path";
import { readAnalysisDatabase } from "./analysis-database.js";
import type { AnalysisDatabase, DependencyEdge, FileAnalysis, GlobalSymbol } from "./analysis-types.js";
import type { DependencyQueryOptions, FileDependency, FileDependencyResult, GlobalDependency } from "./query-types.js";

const slash = (value: string): string => value.replace(/\\/g, "/");
const key = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;

/**
 * Reusable, read-only query index. Build once per analysis snapshot and query many files.
 * Treat the supplied database as immutable; create a new instance after an analysis update.
 */
export class DependencyQuery {
  private readonly files = new Map<string, { name: string; record: FileAnalysis }>();
  private readonly symbols = new Map<string, GlobalSymbol>();
  private readonly outgoing = new Map<string, DependencyEdge[]>();
  private readonly root: string | undefined;

  constructor(database: AnalysisDatabase, sourceRoot?: string) {
    if (database.schemaVersion !== 1) throw new Error("Unsupported analysis schema; expected schemaVersion 1.");
    this.root = sourceRoot === undefined ? undefined : path.resolve(sourceRoot);
    for (const [name, record] of Object.entries(database.files)) this.files.set(key(name), { name, record });
    for (const symbol of database.globals) this.symbols.set(symbol.name, symbol);
    for (const edge of database.dependencies) {
      let edges = this.outgoing.get(edge.from);
      if (!edges) this.outgoing.set(edge.from, edges = []);
      edges.push(edge);
    }
  }

  getFileDependencies(file: string, options: DependencyQueryOptions = {}): FileDependencyResult {
    const relative = this.relativePath(file);
    const selected = this.files.get(key(relative));
    if (!selected) throw new Error(`File is not indexed: ${file}. Run analyze to add or update files.`);
    const grouped = new Map<string, GlobalDependency>();
    for (const access of selected.record.globals) {
      if (access.access === "write") continue;
      const symbol = this.symbols.get(access.name);
      if (!symbol) throw new Error(`Missing global index for ${access.name}; rebuild the analysis database.`);
      if (options.includeBuiltins === false && symbol.status === "builtin") continue;
      let dependency = grouped.get(access.name);
      if (!dependency) {
        dependency = { name: symbol.name, status: symbol.status,
          definedInFile: symbol.definitions.some((definition) => definition.file === selected.name),
          definitions: symbol.definitions, accesses: [] };
        grouped.set(access.name, dependency);
      }
      dependency.accesses.push(access);
    }

    const found = new Map<string, FileDependency>();
    const queue: Array<{ file: string; depth: number }> = [{ file: selected.name, depth: 0 }];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      for (const edge of this.outgoing.get(current.file) ?? []) {
        // Cycles may point back to the selected file, which is not an "other file" dependency.
        if (edge.to === selected.name) continue;
        let dependency = found.get(edge.to);
        if (!dependency) {
          dependency = { file: edge.to, depth: current.depth + 1, direct: current.depth === 0, reasons: [] };
          found.set(edge.to, dependency);
          if (options.transitive) queue.push({ file: edge.to, depth: dependency.depth });
        }
        dependency.reasons.push(edge);
      }
    }
    // Return detached records: mutating a result must not change future queries.
    return structuredClone({
      file: selected.name, transitive: options.transitive ?? false,
      globals: [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name)),
      files: [...found.values()].sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file)),
      modules: selected.record.modules, diagnostics: selected.record.diagnostics,
    });
  }

  private relativePath(file: string): string {
    if (!file) throw new Error("A file path is required.");
    const portable = slash(file);
    let relative = portable;
    if (path.isAbsolute(portable)) {
      if (!this.root) throw new Error("Absolute file queries require a sourceRoot or openDependencyQuery(databasePath).");
      relative = slash(path.relative(this.root, path.resolve(portable)));
    }
    const normalized = path.posix.normalize(relative);
    if (normalized === ".." || normalized.startsWith("../") || path.isAbsolute(normalized)) throw new Error(`File is outside the analyzed root: ${file}`);
    return normalized;
  }
}

/** Read a saved database once; the resulting index works even if Lua sources are unavailable. */
export function openDependencyQuery(databasePath: string): DependencyQuery {
  const absolute = path.resolve(databasePath);
  const database = readAnalysisDatabase(absolute);
  return new DependencyQuery(database, path.resolve(path.dirname(absolute), database.root));
}
