import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { convertLua } from "../converter.js";
import { RUNTIME_SOURCE } from "../runtime-source.js";

function assertValidTypeScript(code: string): void {
  const result = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics ?? [], []);
}

test("converts a class, method, table and pairs loop in compatible mode", () => {
  const lua = `
local View = class("View", BaseView)

function View:ctor(value)
    View.super.ctor(self)
    self.value = value
end

function View:sum(items)
    local total = 0
    for _, value in ipairs(items) do
        total = total + value
    end
    return total
end

return View
`;
  const result = convertLua(lua, { mode: "compatible", sourceName: "view.lua" });
  assertValidTypeScript(result.code);
  assert.match(result.code, /const View = luaClass\("View", BaseView\)/);
  assert.match(result.code, /View\.prototype\.ctor = function/);
  assert.match(result.code, /for \(const \[_, value\] of luaIpairs\(items\)\)/);
  assert.match(result.code, /export default View/);
  assert.equal(result.diagnostics.filter((item) => item.severity === "error").length, 0);
});

test("uses Lua truthiness and table helpers in compatible mode", () => {
  const lua = `
local values = {10, 20, key = "value"}
if 0 and values then
    values[1] = nil
end
`;
  const result = convertLua(lua, { mode: "compatible" });
  assertValidTypeScript(result.code);
  assert.match(result.code, /luaTable/);
  assert.match(result.code, /luaTruthy\(luaAnd/);
  assert.match(result.code, /values\[1\] = luaFirst\(undefined\)/);
});

test("uses Lua 5.1 grammar and rejects Lua 5.2 goto syntax", () => {
  assert.throws(
    () => convertLua("goto done\n::done::\n", { mode: "compatible" }),
    /unexpected|identifier|symbol|expected/i,
  );
});

test("maps Lua 5.1 unpack and diagnoses environment functions", () => {
  const lua = `
local values = {10, 20}
local a, b = unpack(values)
setfenv(1, {})
`;
  const result = convertLua(lua, { mode: "compatible" });
  assertValidTypeScript(result.code);
  assert.match(result.code, /luaUnpack\(values\)/);
  assert.ok(result.diagnostics.some((item) => item.code === "LUA2TS_LUA51_ENVIRONMENT"));
});

function executeConverted(source: string, mode: "compatible" | "syntax" = "compatible"): any {
  const result = convertLua(source, { mode });
  assertValidTypeScript(result.code);
  const runtime: Record<string, unknown> = {};
  const compile = (code: string): string => ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(compile(RUNTIME_SOURCE), { exports: runtime });
  const output: Record<string, unknown> = {};
  runInNewContext(compile(result.code), { exports: output, require: () => runtime });
  return output.default;
}

test("compatible vararg tables preserve nil positions, numeric indexes, and empty argument lists", () => {
  const values = executeConverted('local function capture(...) return {10, ...} end\nreturn capture(20, nil, 40)');
  assert.equal(values[1], 10);
  assert.equal(values[2], 20);
  assert.equal(values[3], undefined);
  assert.equal(values[4], 40);
  const empty = executeConverted('local function capture(...) return {...} end\nreturn capture()');
  assert.equal(Reflect.ownKeys(empty).length, 0);
});

test("varargs before another field use one value, and mixed keyed tables expand a trailing vararg", () => {
  for (const mode of ["compatible", "syntax"] as const) {
    const firstOnly = executeConverted('local function capture(...) return {..., 99, tag = "ok"} end\nreturn capture(10, 20)', mode);
    assert.equal(firstOnly[1], 10);
    assert.equal(firstOnly[2], 99);
    assert.equal(firstOnly[3], undefined);
    assert.equal(firstOnly.tag, "ok");
    const trailing = executeConverted('local function capture(...) return {tag = "ok", 5, ...} end\nreturn capture(10, 20)', mode);
    assert.equal(trailing[1], 5);
    assert.equal(trailing[2], 10);
    assert.equal(trailing[3], 20);
    assert.equal(trailing.tag, "ok");
    const list = executeConverted('local function capture(...) return {..., 99} end\nreturn capture(10, 20)', mode);
    assert.equal(list[1], 10);
    assert.equal(list[2], 99);
    assert.equal(list[3], undefined);
  }
});
