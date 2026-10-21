import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));

function fixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lua2ts-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(cwd: string, ...args: string[]): void {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
}

test("file output appends .ts beside a relative input and preserves the source", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "source files"));
  const input = path.join(root, "source files", "view.lua");
  const source = "return 42\n";
  fs.writeFileSync(input, source);

  run(root, path.join("source files", "view.lua"));

  assert.match(fs.readFileSync(`${input}.ts`, "utf8"), /export default 42/);
  assert.ok(fs.existsSync(path.join(root, "source files", "lua-runtime.ts")));
  assert.equal(fs.readFileSync(input, "utf8"), source);
  assert.equal(fs.existsSync(path.join(root, "view.lua.ts")), false);
});

test("directory output appends ts and preserves nested paths with a trailing separator", (t) => {
  const root = fixture(t);
  const input = path.join(root, "lua-source");
  fs.mkdirSync(path.join(input, "sub"), { recursive: true });
  fs.writeFileSync(path.join(input, "sub", "view.LUA"), "return 42\n");
  fs.writeFileSync(path.join(input, "notes.txt"), "ignored");

  run(root, `${input}${path.sep}`);

  assert.match(fs.readFileSync(path.join(`${input}ts`, "sub", "view.LUA.ts"), "utf8"), /export default 42/);
  assert.ok(fs.existsSync(path.join(`${input}ts`, "sub", "lua-runtime.ts")));
  assert.equal(fs.existsSync(path.join(`${input}ts`, "notes.txt.ts")), false);
  assert.equal(fs.existsSync(path.join(input, "sub", "view.LUA.ts")), false);
});

test("empty input directories still produce an output directory", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "empty"));

  run(root, "empty");

  assert.ok(fs.statSync(path.join(root, "emptyts")).isDirectory());
});

test("explicit output paths override the default suffix", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "input.lua"), "return 42\n");

  run(root, "input.lua", "-o", path.join("custom", "result.ts"));

  assert.match(fs.readFileSync(path.join(root, "custom", "result.ts"), "utf8"), /export default 42/);
  assert.equal(fs.existsSync(path.join(root, "input.lua.ts")), false);
});

test("analyze command creates a database and updates it without converting sources", (t) => {
  const root = fixture(t);
  const input = path.join(root, "source");
  fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, "main.lua"), "Global = 1");

  run(root, "analyze", input);
  const db = path.join(input, "lua-analysis.json");
  assert.equal(JSON.parse(fs.readFileSync(db, "utf8")).globals[0].name, "Global");
  assert.equal(fs.existsSync(`${input}ts`), false);
  fs.writeFileSync(path.join(input, "main.lua"), "Updated = 2");
  run(root, "analyze", input);
  assert.equal(JSON.parse(fs.readFileSync(db, "utf8")).globals[0].name, "Updated");
});

test("analyze CLI validates options and reports parse failures while writing diagnostics", (t) => {
  const root = fixture(t);
  const missing = spawnSync(process.execPath, [cli, "analyze", root, "--db"], { encoding: "utf8" });
  assert.equal(missing.status, 2, missing.error?.message);
  assert.match(missing.stderr, /Missing value/);
  fs.writeFileSync(path.join(root, "broken.lua"), "function (");
  const result = spawnSync(process.execPath, [cli, "analyze", root], { encoding: "utf8" });
  assert.equal(result.status, 1, result.error?.message);
  const db = JSON.parse(fs.readFileSync(path.join(root, "lua-analysis.json"), "utf8"));
  assert.equal(db.files["broken.lua"].diagnostics[0].code, "LUA_ANALYSIS_PARSE_ERROR");
});

test("query CLI discovers its database and supports root-relative paths, JSON, and transitive dependencies", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub/main.lua"), 'require("provider"); return Shared');
  fs.writeFileSync(path.join(root, "provider.lua"), 'require("deep"); Shared = 1');
  fs.writeFileSync(path.join(root, "deep.lua"), "return {}");
  run(root, "analyze", root);
  const result = spawnSync(process.execPath, [cli, "query", "sub/main.lua", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const direct = JSON.parse(result.stdout);
  assert.equal(direct.file, "sub/main.lua");
  assert.deepEqual(direct.files.map((file: { file: string }) => file.file), ["provider.lua"]);
  const db = path.join(root, "lua-analysis.json");
  const recursive = spawnSync(process.execPath, [cli, "query", "sub/main.lua", "--db", db, "--transitive", "--no-builtins", "--json"], { encoding: "utf8" });
  assert.equal(recursive.status, 0, recursive.stderr);
  const transitive = JSON.parse(recursive.stdout);
  assert.deepEqual(transitive.files.map((file: { file: string }) => file.file), ["provider.lua", "deep.lua"]);
  assert.deepEqual(transitive.globals.map((global: { name: string }) => global.name), ["Shared"]);
  const text = spawnSync(process.execPath, [cli, "query", "sub/main.lua", "--db", db], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Global dependencies/);
  assert.match(text.stdout, /Shared/);
  assert.match(text.stdout, /File dependencies/);
});

test("query CLI rejects missing options/files and surfaces incomplete analysis without modifying the database", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "main.lua"), "return External");
  run(root, "analyze", root);
  const db = path.join(root, "lua-analysis.json");
  const original = fs.readFileSync(db, "utf8");
  for (const args of [["main.lua", "--db"], ["missing.lua", "--db", db], ["main.lua", "--unknown"]]) {
    const result = spawnSync(process.execPath, [cli, "query", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
  }
  assert.equal(fs.readFileSync(db, "utf8"), original);
  const modified = JSON.parse(original);
  modified.files["main.lua"].diagnostics.push({ severity: "error", code: "INCOMPLETE", message: "Test incomplete analysis" });
  fs.writeFileSync(db, JSON.stringify(modified));
  const incomplete = spawnSync(process.execPath, [cli, "query", "main.lua", "--db", db, "--json"], { encoding: "utf8" });
  assert.equal(incomplete.status, 1, incomplete.stderr);
  assert.equal(JSON.parse(incomplete.stdout).diagnostics[0].code, "INCOMPLETE");
});

test("analyze progress writes to stderr, supports opt-out, and does not change database contents", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "main.lua"), "return External");
  const first = spawnSync(process.execPath, [cli, "analyze", root, "--progress"], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /Files \[=+\] 100% 1\/1/);
  assert.match(first.stderr, /main.lua/);
  assert.match(first.stderr, /Writing analysis database/);
  assert.match(first.stderr, /Analysis complete: 1\/1 files/);
  assert.equal(first.stdout.includes("Files ["), false);
  assert.equal(first.stderr.includes("\x1b"), false);
  const db = path.join(root, "lua-analysis.json");
  const original = fs.readFileSync(db, "utf8");
  const reused = spawnSync(process.execPath, [cli, "analyze", root, "--progress"], { encoding: "utf8" });
  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stderr, /parsed 0, reused 1/);
  for (const args of [[], ["--progress", "--no-progress"]]) {
    const result = spawnSync(process.execPath, [cli, "analyze", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  }
  assert.equal(fs.readFileSync(db, "utf8"), original);
});

test("analyze CLI successfully indexes compatibility files and reports their parser modes", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "break.lua"), "repeat if Stop then break; end until true\nResult = External");
  fs.writeFileSync(path.join(root, "jit.lua"), "local num = 0ULL\nResult2 = External2");
  const result = spawnSync(process.execPath, [cli, "analyze", root, "--no-progress"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Compatibility: 2 file\(s\)/);
  assert.match(result.stdout, /Diagnostics: 0 errors, 0 warnings/);
  const database = JSON.parse(fs.readFileSync(path.join(root, "lua-analysis.json"), "utf8"));
  assert.equal(database.files["break.lua"].parseMode, "5.2");
  assert.equal(database.files["jit.lua"].parseMode, "LuaJIT");
});
