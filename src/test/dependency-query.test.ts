import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeDirectory } from "../analyzer.js";
import { DependencyQuery, openDependencyQuery } from "../dependency-query.js";

function fixture(t: test.TestContext, sources: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lua2ts-query-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(sources)) {
    const output = path.join(root, file);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, source);
  }
  return root;
}

test("direct queries group global uses, preserve candidate definitions and explain file dependencies", (t) => {
  const root = fixture(t, {
    "main.lua": `local p = require("provider")
Own = 1
Unused = 2
local function f() return Shared, Shared.member, Own, print, External end
Shared.changed = 3
`,
    "provider.lua": "Shared = {}",
    "alternative.lua": "Shared = {}",
    "unrelated.lua": "Unrelated = {}",
  });
  const { database } = analyzeDirectory(root);
  const query = new DependencyQuery(database, root);
  const result = query.getFileDependencies("main.lua");
  assert.deepEqual(result.globals.map((global) => global.name), ["External", "Own", "print", "require", "Shared"].sort((a, b) => a.localeCompare(b)));
  assert.equal(result.globals.some((global) => global.name === "Unused"), false);
  const shared = result.globals.find((global) => global.name === "Shared")!;
  assert.equal(shared.accesses.length, 3);
  assert.ok(shared.accesses.some((access) => access.access === "member-write"));
  assert.deepEqual(shared.definitions.map((definition) => definition.file), ["alternative.lua", "provider.lua"]);
  assert.equal(shared.definedInFile, false);
  assert.equal(result.globals.find((global) => global.name === "Own")?.definedInFile, true);
  assert.equal(result.globals.find((global) => global.name === "External")?.status, "external");
  assert.deepEqual(result.files.map((file) => file.file), ["alternative.lua", "provider.lua"]);
  assert.ok(result.files.every((file) => file.direct && file.depth === 1));
  const provider = result.files.find((file) => file.file === "provider.lua")!;
  assert.ok(provider.reasons.some((reason) => reason.kind === "load" && reason.loader === "require"));
  assert.ok(provider.reasons.some((reason) => reason.kind === "global" && reason.symbol === "Shared" && reason.line > 0));
  const noBuiltins = query.getFileDependencies("main.lua", { includeBuiltins: false });
  assert.equal(noBuiltins.globals.some((global) => global.status === "builtin"), false);
  assert.deepEqual(noBuiltins.files, result.files);
});

test("transitive traversal is cycle-safe, retains alternative reasons, and reports shortest depths", (t) => {
  const root = fixture(t, {
    "main.lua": 'require("a"); require("b"); require("main")',
    "a.lua": 'require("c")',
    "b.lua": 'require("c")',
    "c.lua": 'require("a"); require("main"); return DeepGlobal',
    "provider.lua": "DeepGlobal = 1",
  });
  const { database } = analyzeDirectory(root);
  const query = new DependencyQuery(database);
  assert.deepEqual(query.getFileDependencies("main.lua").files.map((file) => file.file), ["a.lua", "b.lua"]);
  const result = query.getFileDependencies("main.lua", { transitive: true });
  assert.deepEqual(result.files.map((file) => [file.file, file.depth]), [["a.lua", 1], ["b.lua", 1], ["c.lua", 2], ["provider.lua", 3]]);
  assert.equal(result.files.find((file) => file.file === "c.lua")?.reasons.length, 2);
  assert.equal(result.files.find((file) => file.file === "a.lua")?.reasons.length, 2);
  assert.equal(result.files.find((file) => file.file === "provider.lua")?.direct, false);
  // Globals/modules are scoped to the selected file even when file traversal is transitive.
  assert.equal(result.globals.some((global) => global.name === "DeepGlobal"), false);
  assert.equal(result.modules.length, 3);
});

test("queries retain unresolved loader calls and parse diagnostics", (t) => {
  const root = fixture(t, {
    "main.lua": 'require("external"); require(dynamic)',
    "broken.lua": "function (",
    "definitions.lua": "OnlyDefined = 1",
  });
  const { database } = analyzeDirectory(root);
  const query = new DependencyQuery(database);
  const result = query.getFileDependencies("main.lua");
  assert.deepEqual(result.modules.map((module) => module.status), ["external", "dynamic"]);
  assert.deepEqual(result.files, []);
  assert.equal(result.diagnostics[0].code, "LUA_ANALYSIS_DYNAMIC_DEPENDENCY");
  assert.equal(query.getFileDependencies("broken.lua").diagnostics[0].severity, "error");
  assert.deepEqual(query.getFileDependencies("definitions.lua").globals, []);
});

test("saved queries resolve portable relative/absolute paths and work without source files", (t) => {
  const root = fixture(t, { "src/sub/main.lua": "return External" });
  const sourceRoot = path.join(root, "src");
  const db = path.join(root, "index", "custom.json");
  analyzeDirectory(sourceRoot, { database: db });
  const query = openDependencyQuery(db);
  const expected = query.getFileDependencies("sub/main.lua");
  assert.deepEqual(query.getFileDependencies("./sub/../sub/main.lua"), expected);
  assert.deepEqual(query.getFileDependencies("sub\\main.lua"), expected);
  assert.deepEqual(query.getFileDependencies(path.join(sourceRoot, "sub/main.lua")), expected);
  if (process.platform === "win32") assert.deepEqual(query.getFileDependencies("SUB/MAIN.LUA"), expected);
  fs.unlinkSync(path.join(sourceRoot, "sub/main.lua"));
  assert.deepEqual(query.getFileDependencies("sub/main.lua"), expected);
  assert.throws(() => query.getFileDependencies("missing.lua"), /not indexed/);
  assert.throws(() => query.getFileDependencies("../escape.lua"), /outside/);
  assert.throws(() => query.getFileDependencies(path.join(root, "escape.lua")), /outside/);
  assert.throws(() => query.getFileDependencies(""), /required/);
});

test("an index is reused without rescanning database arrays and results cannot mutate future queries", (t) => {
  const root = fixture(t, { "main.lua": "return Shared", "provider.lua": "Shared = 1" });
  const { database } = analyzeDirectory(root);
  const query = new DependencyQuery(database);
  // Accessing these top-level collections again would make every query scan the whole database.
  for (const field of ["files", "globals", "dependencies"] as const) {
    Object.defineProperty(database, field, { get() { throw new Error("Unexpected full-database scan"); } });
  }
  const expected = query.getFileDependencies("main.lua");
  const changed = query.getFileDependencies("main.lua");
  changed.globals[0].definitions[0].file = "mutated.lua";
  changed.globals[0].accesses[0].name = "mutated";
  changed.files[0].reasons[0].to = "mutated.lua";
  for (let index = 0; index < 50; index += 1) assert.deepEqual(query.getFileDependencies("main.lua"), expected);
});

test("opening a new snapshot picks up database updates without altering an existing query index", (t) => {
  const root = fixture(t, { "main.lua": "return Shared", "provider.lua": "Shared = 1" });
  const initial = analyzeDirectory(root);
  const before = openDependencyQuery(initial.databasePath);
  fs.writeFileSync(path.join(root, "main.lua"), "return Changed");
  analyzeDirectory(root);
  const after = openDependencyQuery(initial.databasePath);
  assert.equal(before.getFileDependencies("main.lua").globals[0].name, "Shared");
  assert.equal(after.getFileDependencies("main.lua").globals[0].name, "Changed");
  assert.deepEqual(after.getFileDependencies("main.lua").files, []);
});
