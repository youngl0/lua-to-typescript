import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeDirectory, analyzeLua } from "../analyzer.js";
import { convertLua } from "../converter.js";

test("analysis prefers Lua 5.1 and emits no compatibility message for ordinary files", () => {
  const result = analyzeLua('local value = External\nResult = require("pkg")\n');
  assert.equal(result.parseMode, "5.1");
  assert.deepEqual(result.diagnostics, []);
});

test("break semicolons use compatibility parsing while preserving scope and original source positions", () => {
  const source = [
    '-- break; require("comment.fake")',
    'local ignored = "break; require(\\"string.fake\\")"',
    "repeat",
    "    local inside = Source",
    "    if Stop then break; end",
    "until true",
    'Result = require("real.module")',
  ].join("\r\n");
  const result = analyzeLua(source);
  assert.equal(result.parseMode, "5.2");
  assert.equal(result.diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.equal(result.diagnostics.filter((item) => item.code === "LUA_ANALYSIS_COMPATIBILITY_MODE").length, 1);
  assert.deepEqual([...new Set(result.globals.map((item) => item.name))].sort(), ["Result", "Source", "Stop", "require"].sort());
  assert.deepEqual(result.modules.map(({ request, expression, line, column }) => ({ request, expression, line, column })), [
    { request: "real.module", expression: '"real.module"', line: 7, column: 10 },
  ]);
  assert.deepEqual(result.globals.find((item) => item.name === "Source"), { name: "Source", access: "read", line: 4, column: 20 });
});

test("multiline long-string chained calls are analyzed without executing embedded source", () => {
  const source = [
    "local fn = load[=[return function(value)",
    "    Injected = Dangerous(value >> 1)",
    "    return value & 3",
    "end]=]()",
    'After = require("after.module")',
  ].join("\n");
  const result = analyzeLua(source);
  assert.equal(result.parseMode, "5.2");
  assert.equal(result.diagnostics.some((item) => item.severity === "error"), false);
  assert.ok(result.diagnostics.some((item) => item.code === "LUA_ANALYSIS_DYNAMIC_ENVIRONMENT"));
  assert.equal(result.globals.some((item) => ["Injected", "Dangerous", "value"].includes(item.name)), false);
  assert.deepEqual(result.modules.map(({ request, line, column }) => ({ request, line, column })), [
    { request: "after.module", line: 5, column: 9 },
  ]);
});

test("LuaJIT integer suffixes remain literal tokens without shifting following dependency positions", () => {
  const source = [
    "local unsigned = 18446744073709551615ULL",
    "local signed = -1LL",
    'Result = require("ffi")',
    "function Exported(value) return unsigned + signed + value + External end",
  ].join("\n");
  const result = analyzeLua(source);
  assert.equal(result.parseMode, "LuaJIT");
  assert.equal(result.diagnostics.some((item) => item.severity === "error"), false);
  assert.deepEqual([...new Set(result.globals.map((item) => item.name))].sort(), ["Exported", "External", "Result", "require"].sort());
  assert.equal(result.modules[0].request, "ffi");
  assert.equal(result.modules[0].line, 3);
  assert.equal(result.modules[0].column, 10);
});

test("invalid source still fails and analysis fallback does not change converter grammar or later scope tracking", () => {
  const malformed = analyzeLua("Broken = 1\nfunction (");
  assert.equal(malformed.parseMode, undefined);
  assert.deepEqual(malformed.globals, []);
  assert.equal(malformed.diagnostics[0].code, "LUA_ANALYSIS_PARSE_ERROR");
  const newer = "goto done\n::done::\nreturn {}";
  assert.equal(analyzeLua(newer).parseMode, "LuaJIT");
  assert.throws(() => convertLua(newer, { mode: "compatible" }));
  assert.throws(() => convertLua("local value = 0ULL", { mode: "compatible" }));
  const ordinary = analyzeLua("local Local = Global\nreturn Local");
  assert.equal(ordinary.parseMode, "5.1");
  assert.deepEqual(ordinary.globals.map((item) => item.name), ["Global"]);
});

test("analyzer version invalidates old failed caches and preserves notes, source bytes and compatibility mode on reuse", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lua2ts-parser-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = "repeat if Stop then break; end until true\nResult = External\n";
  const input = path.join(root, "main.lua");
  fs.writeFileSync(input, source);
  const initial = analyzeDirectory(root);
  initial.database.analyzerVersion = 1;
  initial.database.annotations = { note: "preserve me" };
  initial.database.files["main.lua"].globals = [];
  initial.database.files["main.lua"].diagnostics = [{ severity: "error", code: "LUA_ANALYSIS_PARSE_ERROR", message: "old parser" }];
  delete initial.database.files["main.lua"].parseMode;
  fs.writeFileSync(initial.databasePath, JSON.stringify(initial.database));

  const updated = analyzeDirectory(root);
  assert.equal(updated.changes.updated, 1);
  assert.equal(updated.changes.reused, 0);
  assert.equal(updated.database.files["main.lua"].parseMode, "5.2");
  assert.equal(updated.database.files["main.lua"].diagnostics.some((item) => item.severity === "error"), false);
  assert.deepEqual(updated.database.annotations, { note: "preserve me" });
  assert.ok(updated.database.globals.some((item) => item.name === "Result"));
  const reused = analyzeDirectory(root);
  assert.equal(reused.changes.reused, 1);
  assert.equal(reused.database.files["main.lua"].parseMode, "5.2");
  assert.deepEqual(reused.database, updated.database);
  assert.equal(fs.readFileSync(input, "utf8"), source);
});
