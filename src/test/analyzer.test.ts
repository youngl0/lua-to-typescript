import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeDirectory, analyzeLua } from "../analyzer.js";

function fixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lua2ts-analysis-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root: string, file: string, source: string): void {
  const output = path.join(root, file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, source);
}

test("globals respect local scope, declaration timing, loop variables, fields, and implicit self", () => {
  const result = analyzeLua(`
local outer = outer
local function helper(arg) return arg, outer end
Global = { field = Other }
function Global:method(arg)
  self.value = arg
  local inner = Captured
  for key, value in pairs(Items) do helper(key, value) end
  for index = 1, Limit do self.value = index end
  return inner
end
function Public(arg) return helper(arg), Missing end
do local Hidden = 1 end
Hidden = 2
`);
  assert.deepEqual(result.diagnostics, []);
  const names = [...new Set(result.globals.map((item) => item.name))].sort();
  assert.deepEqual(names, ["Captured", "Global", "Hidden", "Items", "Limit", "Missing", "Other", "Public", "outer", "pairs"].sort());
  assert.equal(result.globals.filter((item) => item.name === "outer").length, 1);
  assert.ok(result.globals.some((item) => item.name === "Global" && item.access === "write"));
  assert.ok(result.globals.some((item) => item.name === "Global" && item.access === "member-write" && item.memberPath?.[0] === "method"));
  assert.ok(result.globals.some((item) => item.name === "Public" && item.access === "write"));
});

test("explicit global table reads and writes share names with bare globals", () => {
  const result = analyzeLua(`
_G.Foo = 1
_G["B" .. "ar"] = Foo
function _G.Exported() return _G.Foo end
_G.Foo.member = _G["Bar"]
rawset(_G, "Baz", rawget(_G, "Foo"))
_G[computed] = 2
do local _G = {}; _G.Private = 3 end
`);
  assert.ok(result.globals.some((item) => item.name === "Foo" && item.access === "write"));
  assert.ok(result.globals.some((item) => item.name === "Bar" && item.access === "write"));
  assert.ok(result.globals.some((item) => item.name === "Baz" && item.access === "write"));
  assert.ok(result.globals.some((item) => item.name === "Exported" && item.access === "write"));
  assert.ok(result.globals.some((item) => item.name === "Foo" && item.access === "member-write"));
  assert.equal(result.globals.some((item) => ["member", "Private", "computed"].includes(item.name) && item.access === "write"), false);
  assert.ok(result.diagnostics.some((item) => item.code === "LUA_ANALYSIS_DYNAMIC_GLOBAL"));
});

test("loads include string shorthand, concatenated literals, escapes, custom names, and dynamic expressions", () => {
  const result = analyzeLua(`
require "a.b"
require("a" .. ".c")
require [[long.module]]
require("a\\046d")
require(name)
utils.import("custom")
do local require = function() end; require("shadowed") end
setfenv(1, env)
`, ["require", "utils.import"]);
  assert.deepEqual(result.modules.map((item) => item.request), ["a.b", "a.c", "long.module", "a.d", undefined, "custom"]);
  assert.ok(result.modules.some((item) => item.status === "dynamic"));
  assert.ok(result.diagnostics.some((item) => item.code === "LUA_ANALYSIS_DYNAMIC_DEPENDENCY"));
  assert.ok(result.diagnostics.some((item) => item.code === "LUA_ANALYSIS_DYNAMIC_ENVIRONMENT"));
});

test("database resolves ordered modules, file loads, global dependencies, and reverse indexes", (t) => {
  const root = fixture(t);
  write(root, "provider.lua", "Shared = {}\n");
  write(root, "pkg/init.lua", "return {}\n");
  write(root, "pkg.lua", "return {}\n");
  write(root, "consumer.lua", `local p = require("pkg")
dofile("provider.lua")
loadfile("provider.lua")
Shared.value = External
require("native.missing")
`);
  const { database } = analyzeDirectory(root);
  assert.equal(database.schemaVersion, 1);
  assert.equal(database.root, ".");
  assert.deepEqual(database.files["consumer.lua"].modules.map((item) => [item.status, item.target]), [
    ["resolved", "pkg.lua"], ["resolved", "provider.lua"], ["resolved", "provider.lua"], ["external", undefined],
  ]);
  assert.ok(database.dependencies.some((edge) => edge.kind === "global" && edge.from === "consumer.lua" && edge.to === "provider.lua" && edge.symbol === "Shared"));
  assert.deepEqual(database.dependents["provider.lua"], ["consumer.lua"]);
  assert.equal(database.globals.find((item) => item.name === "Shared")?.status, "defined");
  assert.equal(database.globals.find((item) => item.name === "External")?.status, "external");
  assert.equal(database.globals.find((item) => item.name === "require")?.status, "builtin");
});

test("protected and explicit _G loader calls resolve; loader aliases are diagnosed", () => {
  const result = analyzeLua(`
pcall(require, "protected")
_G.require("explicit")
_G["require"]("indexed")
local req = require
req("alias")
local indirect = utils.import
`, ["require", "utils.import"]);
  assert.deepEqual(result.modules.map((item) => item.request), ["protected", "explicit", "indexed"]);
  assert.equal(result.diagnostics.filter((item) => item.code === "LUA_ANALYSIS_LOADER_REFERENCE").length, 2);
});

test("incremental updates re-resolve unchanged files and purge deleted symbols and edges", (t) => {
  const root = fixture(t);
  write(root, "consumer.lua", 'require("new")\nreturn Shared\n');
  write(root, "old.lua", "Shared = 1\n");
  const initial = analyzeDirectory(root);
  assert.deepEqual(initial.changes, { added: 2, updated: 0, reused: 0, removed: 0 });
  initial.database.annotations = { globals: { Shared: { owner: "team", note: "migration" } }, custom: [1, 2] };
  fs.writeFileSync(initial.databasePath, JSON.stringify(initial.database));
  write(root, "new.lua", "New = 2\n");
  fs.unlinkSync(path.join(root, "old.lua"));

  const updated = analyzeDirectory(root);
  assert.deepEqual(updated.changes, { added: 1, updated: 0, reused: 1, removed: 1 });
  assert.equal(updated.database.files["consumer.lua"].modules[0].target, "new.lua");
  assert.equal(updated.database.globals.find((item) => item.name === "Shared")?.status, "external");
  assert.equal(updated.database.dependencies.some((edge) => edge.to === "old.lua"), false);
  assert.deepEqual(updated.database.annotations, initial.database.annotations);

  write(root, "new.lua", "Changed = 3\n");
  const changed = analyzeDirectory(root);
  assert.equal(changed.changes.updated, 1);
  assert.equal(changed.database.globals.some((item) => item.name === "New"), false);
  const rebuilt = analyzeDirectory(root, { rebuild: true });
  assert.equal(rebuilt.changes.updated, 2);
  assert.equal(rebuilt.changes.reused, 0);
  assert.deepEqual(rebuilt.database, changed.database);
  const unchanged = analyzeDirectory(root);
  assert.equal(unchanged.changes.reused, 2);
  assert.equal(fs.readFileSync(unchanged.databasePath, "utf8"), `${JSON.stringify(rebuilt.database, null, 2)}\n`);
});

test("custom resolution config persists and changed configuration invalidates the cache", (t) => {
  const root = fixture(t);
  write(root, "main.lua", 'import("pkg")\n');
  write(root, "lib/pkg.lua", "return {}\n");
  const initial = analyzeDirectory(root, { loaders: ["import"], modulePaths: ["lib/?.lua"] });
  assert.equal(initial.database.files["main.lua"].modules[0].target, "lib/pkg.lua");
  const reused = analyzeDirectory(root);
  assert.equal(reused.changes.reused, 2);
  assert.deepEqual(reused.database.config, initial.database.config);
  const updated = analyzeDirectory(root, { modulePaths: ["?/init.lua"] });
  assert.equal(updated.changes.updated, 2);
  assert.equal(updated.database.files["main.lua"].modules[0].status, "external");
  updated.database.config.loaders.push("otherLoader");
  fs.writeFileSync(updated.databasePath, JSON.stringify(updated.database));
  const manuallyConfigured = analyzeDirectory(root);
  assert.equal(manuallyConfigured.changes.reused, 0);
  assert.equal(manuallyConfigured.changes.updated, 2);
});

test("parse errors replace stale definitions but allow other files to remain indexed", (t) => {
  const root = fixture(t);
  write(root, "broken.lua", "Old = 1");
  write(root, "good.lua", "Good = 2");
  analyzeDirectory(root);
  write(root, "broken.lua", "function (");
  const { database } = analyzeDirectory(root);
  assert.equal(database.files["broken.lua"].diagnostics[0].severity, "error");
  assert.equal(database.globals.some((item) => item.name === "Old"), false);
  assert.ok(database.globals.some((item) => item.name === "Good"));
});

test("database uses relative roots and protects unknown schemas, invalid JSON, and Lua source destinations", (t) => {
  const root = fixture(t);
  write(root, "src/main.lua", "Global = 1");
  const db = path.join(root, "db", "index.json");
  const initial = analyzeDirectory(path.join(root, "src"), { database: db });
  assert.equal(initial.database.root, "../src");
  fs.writeFileSync(db, `\uFEFF${JSON.stringify(initial.database)}`);
  assert.equal(analyzeDirectory(path.join(root, "src"), { database: db }).changes.reused, 1);
  assert.throws(() => analyzeDirectory(root, { database: db }), /different source directory/);
  assert.throws(() => analyzeDirectory(root, { database: path.join(root, "src/main.lua") }), /overwrite/);
  fs.writeFileSync(db, '{"schemaVersion":999}');
  assert.throws(() => analyzeDirectory(root, { database: db, rebuild: true }), /Unsupported analysis schema/);
  assert.equal(fs.readFileSync(db, "utf8"), '{"schemaVersion":999}');
  fs.writeFileSync(db, "broken json");
  assert.throws(() => analyzeDirectory(root, { database: db }));
  assert.equal(fs.readFileSync(db, "utf8"), "broken json");
});

test("empty directories and Lua names matching object prototype keys are handled", (t) => {
  const root = fixture(t);
  assert.deepEqual(analyzeDirectory(root).database.globals, []);
  write(root, "constructor.lua", "constructor = {}; __proto__ = 1\n");
  const { database } = analyzeDirectory(root);
  assert.equal(database.globals.length, 2);
  assert.equal(database.files["constructor.lua"].globals.length, 2);
});
