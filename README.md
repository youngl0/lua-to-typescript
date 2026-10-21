# lua2ts-offline

Deterministic, offline Lua 5.1 to TypeScript transpiler. Conversion does not call an AI service.

This repository contains the standalone converter, Lua analyzer, dependency query APIs, and their tests and usage documentation. Agent orchestration and project-specific cocos2d-x-to-Creator migration designs are maintained separately from this tool.

## Install and build

```powershell
npm install
npm run build
```

## Usage

```powershell
node dist/cli.js input.lua
node dist/cli.js ./lua-source
```

Only an input path is required. Output stays beside the input:

- File: `D:/scripts/input.lua` → `D:/scripts/input.lua.ts`.
- Directory: `D:/scripts/lua-source` → `D:/scripts/lua-sourcets`.
- Nested files keep their relative paths: `lua-source/sub/view.lua` → `lua-sourcets/sub/view.lua.ts`.
- Empty input directories also create an empty output directory.

Relative paths are resolved from the current working directory. Absolute paths and directory paths with a trailing separator are also supported. The default mode is `compatible`.

Optional output paths, modes, and reports:

```powershell
node dist/cli.js input.lua -o output.ts --mode syntax
node dist/cli.js ./lua-source -o ./typescript-output --report ./conversion-report.json
```

`compatible` mode emits `lua-runtime.ts` beside generated files and preserves common Lua behavior such as truthiness, 1-based tables, `pairs`, `ipairs`, multiple returns, and the common `class(name, base)` pattern.

`syntax` mode produces simpler TypeScript-shaped output. It is intended for subsequent manual refactoring and does not preserve every Lua runtime semantic.

The converter's parser is fixed to the Lua 5.1 grammar. Lua 5.2/5.3-only syntax such as `goto`, labels, integer division, and native bitwise operators is rejected during conversion parsing. Directory analysis has the separate compatibility policy below.

The converter reports constructs that cannot be translated safely. In particular, Lua 5.1 environment functions (`setfenv`, `getfenv`, `module`, `loadstring`), project-specific generic iterators, native userdata, and framework-specific module loading may require adapters or manual migration. Lua 5.1 `unpack` and `select` are provided by the compatibility runtime.

## Analyze a Lua directory

```powershell
node dist/cli.js analyze D:/scripts
```

This recursively analyzes Lua 5.1 source files and writes `D:/scripts/lua-analysis.json`. It parses source only and does not execute Lua. `.git`, `.svn`, `node_modules`, and symbolic links are skipped.

Analysis first tries Lua 5.1. If that fails, it tries LuaJIT and then Lua 5.2 against the original source, accepting the first successful parse. This supports legacy `break;`, multiline long-string chained calls such as `load[[...]]()`, and LuaJIT `LL`/`ULL` numeric suffixes. Source text, comments, line/column positions, and hash inputs are preserved. Embedded code in strings is never executed or treated as the containing file's globals. If every mode fails, the original Lua 5.1 error remains a parse error; no partial file index is retained.

Each successfully analyzed file records `parseMode` (`5.1`, `LuaJIT`, or `5.2`). Fallbacks add an informational `LUA_ANALYSIS_COMPATIBILITY_MODE` diagnostic, not a warning/error. This describes the analysis dialect only; it does not claim the converter supports that dialect. Analyzer v2 invalidates older cached records automatically, while retaining annotations and configuration. Existing database schema version 1 remains readable; older records may lack `parseMode` until updated.

In an interactive terminal, analysis displays a live progress bar on stderr with the processed/total file count, percentage, parsed/reused counts, and current file. Scanning, dependency resolution, index building, database writing, and completion have separate stage messages. The percentage describes file processing; completion is shown only after database persistence succeeds. Updates are throttled to avoid slowing large analyses.

Use `--no-progress` to hide progress. Redirected/non-interactive stderr is quiet by default; use `--progress` to enable plain progress lines in logs. Analysis summaries and diagnostics continue to use stdout.

```powershell
node dist/cli.js analyze D:/scripts --no-progress
node dist/cli.js analyze D:/scripts --progress
```

The library API also supports `analyzeDirectory(directory, { onProgress(event) { /* ... */ } })`. Events include `stage`, `completed`, `total`, `parsed`, `reused`, and an optional root-relative `file`. During scanning, `total` is the discovered count so far; file totals become final at the `files` stage. No callback/terminal output is enabled by default for library callers, and progress does not affect the saved database.

Run the same command again after editing sources. The analyzer hashes every file, reuses unchanged file records, reparses changed/new files, removes deleted records, and rebuilds all indexes and dependency links. This also resolves previously missing modules when files are added, even if their consumers have not changed. Output uses stable ordering and relative paths, and an unchanged database is not rewritten. Database replacement uses a temporary file followed by an atomic rename.

```powershell
# Choose a database location or force a full reparse
node dist/cli.js analyze D:/scripts --db D:/analysis/project.json
node dist/cli.js analyze D:/scripts --rebuild

# Recognize project-specific global loaders and module search paths
node dist/cli.js analyze D:/scripts --loader import --loader utils.import --module-path "?.lua" --module-path "lib/?.lua" --module-path "?/init.lua"
```

Custom loaders use `require`-style resolution. Loader names and ordered search templates are saved in `config` and reused on subsequent runs. Supplied `--loader` values replace the previous custom loader list; the three built-in loaders always remain enabled. Supplied `--module-path` values replace the previous template list. Changes to configuration, including manual edits to `config`, invalidate cached analyses. `--rebuild` preserves the saved configuration and annotations.

### What is indexed

- **Global variables:** bare global assignments/functions, reads, and writes through `_G.name`, `_G["name"]`, `rawget(_G, "name")`, and `rawset(_G, "name", value)`. Local declarations, parameters, loop variables, lexical shadowing, and implicit method `self` are excluded. Global-table field mutations such as `Global.member = ...` are recorded as `member-write`, rather than definitions of a new global. Every occurrence has a 1-based line and column.
- **Explicit dependencies:** global `require`, `dofile`, `loadfile`, configured custom loaders, and `pcall(require, "module")`. String literals, Lua long strings, and concatenations of string literals are resolved. `require("a.b")` searches `a/b.lua` and `a/b/init.lua` by default, in that order. `dofile`/`loadfile` paths are resolved against the analyzed root, which is treated as the runtime working directory. Targets outside the scanned tree remain external/unresolved.
- **Potential global dependencies:** a file reading or mutating a global table is linked to every other file assigning that global. These edges are candidates, not proof of runtime load order; assignments in functions/branches and multiple providers are all retained. Reverse dependencies are indexed too.

### Database format and maintenance

The database is readable JSON with exported TypeScript interfaces in `src/analysis-types.ts`:

| Field | Contents |
| --- | --- |
| `schemaVersion`, `analyzerVersion`, `analysisKey` | Format version and cache/configuration fingerprint |
| `root` | Source directory relative to the database file |
| `config` | Recognized loaders and ordered module search templates |
| `files` | Relative file paths mapped to SHA-256 hashes, successful `parseMode`, global accesses, module calls, and diagnostics |
| `globals` | All observed global names, definitions, references, and `defined` / `builtin` / `external` status |
| `dependencies` | Directed `from` → `to` edges with `load` / `global` kind, loader/symbol, and source position |
| `dependents` | File → unique files that depend on it |
| `annotations` | User-maintained metadata, preserved on incremental updates and full rebuilds |

For example, add migration ownership and notes under `annotations`:

```json
{
  "annotations": {
    "globals": {
      "ModelManager": { "owner": "gameplay", "note": "Migrate after BaseModel" }
    },
    "files": {
      "main.lua": { "status": "pending" }
    }
  }
}
```

Edit `annotations` inside the existing database, rather than replacing the database with this fragment. Generated indexes are refreshed each run. Notes for removed files/symbols remain in `annotations` for manual review. Keep the database in version control if it should be shared. Moving the source and database together preserves their relative relationship. An incompatible schema, invalid database, or database belonging to another source directory is rejected without overwriting it; choose a new `--db` path if starting a separate analysis.

### Static analysis limits

`external` means no definition/target was found in the scanned tree; it can be a native binding, external module, missing file, or configuration mismatch. Built-in globals are classified only when observed; the analyzer does not invent unused globals.

Computed `_G` keys, dynamic module names, loader references through aliases, and environment/dynamic-code calls such as `module`, `setfenv`, `load`, and `loadstring` produce diagnostics. The analyzer does not follow arbitrary aliases, execute metatables, emulate `package.path` mutations, inspect native modules, or infer globals generated at runtime. Thus it inventories statically identifiable globals and dependencies; runtime behavior may add more. Syntax errors are recorded per file, while other files remain indexed. The command exits with `1` if any file has parse errors, `2` for command/database/I/O failures, and `0` otherwise; warnings do not fail the command.

## Query file dependencies

After analyzing a directory, query a file directly:

```powershell
node dist/cli.js query D:/scripts/game/view.lua
```

The command finds the nearest `lua-analysis.json` in the file's parent directories. Without `--db`, relative file paths use the current working directory. With an explicit database, relative file paths use the database's analyzed source root:

```powershell
node dist/cli.js query game/view.lua --db D:/scripts/lua-analysis.json
node dist/cli.js query game/view.lua --db D:/scripts/lua-analysis.json --json
node dist/cli.js query game/view.lua --db D:/scripts/lua-analysis.json --transitive --no-builtins
```

Default output lists global names, known definition files, read/member-write positions, direct file dependencies, and the source location and loader/global responsible for each edge. Unresolved and dynamic module calls and analysis diagnostics are also shown. Global writes that are never read or mutated in the selected file are definitions, so they are excluded from its dependency list. A global both defined and used in the selected file has `definedInFile: true`; all known provider definitions are retained. Multiple edges to the same target file are grouped together.

`--transitive` follows load edges and potential global edges recursively, handles cycles, and reports the shortest dependency depth. It includes indirect file dependencies; global variables, module calls, and diagnostics still describe the selected file. `--no-builtins` hides observed Lua built-ins from the global list, while project overrides of built-ins remain visible. `--json` emits only a structured result on stdout, suitable for another tool to consume.

### Reusable JavaScript / TypeScript API

```javascript
import { openDependencyQuery } from "./dist/index.js";

// Read the saved database and build lookup maps once.
const query = openDependencyQuery("D:/scripts/lua-analysis.json");

const direct = query.getFileDependencies("game/view.lua");
const recursive = query.getFileDependencies("game/view.lua", {
  transitive: true,
  includeBuiltins: false,
});

console.log(direct.globals); // Global uses and candidate definitions
console.log(direct.files);   // Unique dependent files with dependency reasons
console.log(direct.modules); // Resolved, external, and dynamic module calls
```

Reuse the same instance to query many files. Initial loading reads the JSON once and builds maps for file names, global symbols, and outgoing dependency edges. Subsequent queries access the selected file's records and its outgoing edges; transitive queries traverse only reachable nodes/edges, followed by sorting and copying the result. They do not scan all files/symbols/edges or parse/read Lua source. A new CLI process pays the initial database loading cost each time, so use the reusable API for frequent queries.

For an existing in-memory analysis result, use `new DependencyQuery(database, sourceRoot)`. `sourceRoot` is optional for root-relative queries and required for absolute file queries. Returned records are detached copies. Treat the input database as immutable, and open a new query instance after updating the database; an existing instance keeps its original snapshot. Both API forms work when the original source files are unavailable. File paths accept `/` and `\`; Windows file matching is case-insensitive, while global names remain case-sensitive.

| Result field | Contents |
| --- | --- |
| `file`, `transitive` | Canonical root-relative input file and traversal mode |
| `globals` | Used global names, status, `definedInFile`, candidate definition positions, and accesses |
| `files` | Unique target files with minimum `depth`, `direct`, and source-position `reasons` |
| `modules` | Every loader call in the selected file, including unresolved/dynamic requests |
| `diagnostics` | Analysis warnings/errors for the selected file |

Queries use the saved analysis snapshot and do not modify it or check source freshness. Run `analyze` again after source changes. Potential global edges retain the static-analysis limits described above. A file missing from the database is an error rather than an empty result. Query exits with `1` for analysis errors in the selected file, `2` for command/database/query failures, and `0` otherwise.
