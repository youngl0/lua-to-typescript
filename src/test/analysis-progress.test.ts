import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AnalysisProgressDisplay } from "../analysis-progress.js";
import { analyzeDirectory } from "../analyzer.js";
import type { AnalysisProgress } from "../analysis-types.js";

const event = (values: Partial<AnalysisProgress> = {}): AnalysisProgress => ({
  stage: "files", completed: 0, total: 10, parsed: 0, reused: 0, ...values,
});

test("terminal progress is throttled, reports real counts, and always shows completion and stage changes", () => {
  const output: string[] = [];
  let time = 0;
  const display = new AnalysisProgressDisplay({ isTTY: true, columns: 200, write: (text) => output.push(text) }, true, () => time);
  display.update(event());
  display.update(event({ completed: 1, parsed: 1 }));
  assert.equal(output.length, 1);
  time = 100;
  display.update(event({ completed: 5, parsed: 2, reused: 3, file: "sub/main.lua" }));
  assert.match(output[1], /50% 5\/10 \| parsed 2, reused 3 \| sub\/main.lua/);
  display.update(event({ completed: 10, parsed: 2, reused: 8 }));
  assert.match(output[2], /100% 10\/10/);
  display.update(event({ stage: "resolve", completed: 10 }));
  assert.match(output[3], /Resolving module dependencies/);
  display.update(event({ stage: "done", completed: 10, parsed: 2, reused: 8 }));
  assert.ok(output[4].endsWith("\n"));
  display.stop();
  assert.equal(output.length, 5);
});

test("progress handles empty directories, narrow terminals, unsafe filenames, and error cleanup", () => {
  const output: string[] = [];
  const display = new AnalysisProgressDisplay({ isTTY: true, columns: 200, write: (text) => output.push(text) });
  display.update(event({ total: 0 }));
  assert.match(output[0], /100% 0\/0/);
  display.update(event({ total: 0, file: "bad\n\x1bfilename.lua" }));
  assert.ok(output[1].includes("bad??filename.lua"));
  assert.equal(output[1].includes("bad\n"), false);
  display.stop();
  assert.equal(output.at(-1), "\n");
  display.stop();
  assert.equal(output.filter((text) => text === "\n").length, 1);
  const narrow: string[] = [];
  const small = new AnalysisProgressDisplay({ isTTY: true, columns: 10, write: (text) => narrow.push(text) });
  small.update(event());
  assert.equal(narrow[0].replace(/\r\x1b\[2K/, "").length, 9);
  small.stop();
});

test("redirected streams are quiet by default and can explicitly show plain progress lines", () => {
  const output: string[] = [];
  const stream = { write: (text: string) => output.push(text) };
  const quiet = new AnalysisProgressDisplay(stream);
  quiet.update(event());
  quiet.stop();
  assert.equal(output.length, 0);
  const enabled = new AnalysisProgressDisplay(stream, true);
  enabled.update(event({ stage: "scan" }));
  enabled.update(event({ stage: "done", completed: 10 }));
  assert.equal(output.length, 2);
  assert.ok(output.every((text) => text.endsWith("\n") && !text.includes("\r") && !text.includes("\x1b")));
});

test("analysis callbacks cover file counts, reuse, empty inputs, and successful persistence without changing the database", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lua2ts-progress-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "main.lua"), "Global = 1");
  const events: AnalysisProgress[] = [];
  const initial = analyzeDirectory(root, { onProgress: (progress) => {
    events.push(progress);
    if (progress.stage === "done") assert.ok(fs.existsSync(path.join(root, "lua-analysis.json")));
  } });
  assert.deepEqual([...new Set(events.map((progress) => progress.stage))], ["load", "scan", "files", "resolve", "index", "write", "done"]);
  assert.ok(events.some((progress) => progress.stage === "files" && progress.completed === 0 && progress.file === "main.lua"));
  assert.deepEqual(events.at(-1), event({ stage: "done", completed: 1, total: 1, parsed: 1 }));
  const updated = analyzeDirectory(root, { onProgress: (progress) => events.push(progress) });
  assert.deepEqual(events.at(-1), event({ stage: "done", completed: 1, total: 1, reused: 1 }));
  assert.deepEqual(updated.database, initial.database);
  fs.unlinkSync(path.join(root, "main.lua"));
  analyzeDirectory(root, { onProgress: (progress) => events.push(progress) });
  assert.deepEqual(events.at(-1), event({ stage: "done", total: 0 }));
});
