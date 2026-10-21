#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import { convertLua } from "./converter.js";
import { RUNTIME_FILE_NAME, RUNTIME_SOURCE } from "./runtime-source.js";
import type { ConversionMode, Diagnostic } from "./types.js";
import { runAnalysis } from "./analysis-cli.js";
import { runQuery } from "./query-cli.js";

interface CliOptions {
  input?: string;
  output?: string;
  mode: ConversionMode;
  emitRuntime: boolean;
  report?: string;
  help: boolean;
}

function usage(): string {
  return `lua2ts-offline

Usage:
  lua2ts <file.lua> [-o file.ts] [--mode syntax|compatible]
  lua2ts <directory> [-o output-directory] [--mode syntax|compatible]
  lua2ts analyze <directory> [--db file.json] [--rebuild]
  lua2ts query <file.lua> [--db file.json] [--transitive] [--json]

Defaults:
  File:      <input>.ts (beside the input file)
  Directory: <input>ts  (beside the input directory; preserves subdirectories)

Options:
  -o, --output <path>       Output file or directory
  --mode <mode>             syntax or compatible (default: compatible)
  --no-runtime              Do not emit lua-runtime.ts in compatible mode
  --report <path>           Write a JSON conversion report
  -h, --help                Show this help

Use lua2ts analyze --help for global-variable and dependency analysis options.
Use lua2ts query --help to query an existing database without parsing Lua.
`;
}

function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = { mode: "compatible", emitRuntime: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "-o" || argument === "--output") options.output = argv[++index];
    else if (argument === "--mode") {
      const mode = argv[++index];
      if (mode !== "syntax" && mode !== "compatible") throw new Error(`Unknown mode: ${mode}`);
      options.mode = mode;
    } else if (argument === "--no-runtime") options.emitRuntime = false;
    else if (argument === "--report") options.report = argv[++index];
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (!options.input) options.input = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  return options;
}

function collectLuaFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectLuaFiles(absolute));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".lua")) files.push(absolute);
  }
  return files;
}

function syntaxDiagnostics(code: string, fileName: string): Diagnostic[] {
  const result = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName,
    reportDiagnostics: true,
  });
  return (result.diagnostics ?? []).map((diagnostic) => {
    const position = diagnostic.file && diagnostic.start != null
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : undefined;
    return {
      severity: "error" as const,
      code: `TS${diagnostic.code}`,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      line: position ? position.line + 1 : undefined,
      column: position ? position.character + 1 : undefined,
    };
  });
}

function outputFor(input: string, inputRoot: string, outputRoot: string, directoryMode: boolean): string {
  if (!directoryMode) return outputRoot;
  const relative = `${path.relative(inputRoot, input)}.ts`;
  return path.join(outputRoot, relative);
}

function main(): number {
  let options: CliOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 2;
  }

  if (options.help || !options.input) {
    console.log(usage());
    return options.help ? 0 : 2;
  }

  const input = path.resolve(options.input);
  if (!fs.existsSync(input)) {
    console.error(`Input does not exist: ${input}`);
    return 2;
  }

  const directoryMode = fs.statSync(input).isDirectory();
  const files = directoryMode ? collectLuaFiles(input) : [input];
  const outputRoot = path.resolve(options.output ?? `${input}${directoryMode ? "ts" : ".ts"}`);
  if (directoryMode) fs.mkdirSync(outputRoot, { recursive: true });
  const report: Array<Record<string, unknown>> = [];
  let hasErrors = false;
  const runtimeDirectories = new Set<string>();

  for (const file of files) {
    const output = outputFor(file, input, outputRoot, directoryMode);
    try {
      const source = fs.readFileSync(file, "utf8");
      const result = convertLua(source, {
        mode: options.mode,
        sourceName: path.relative(process.cwd(), file),
        runtimeImport: "./lua-runtime.js",
      });
      const parserDiagnostics = syntaxDiagnostics(result.code, output);
      const diagnostics = [...result.diagnostics, ...parserDiagnostics];
      hasErrors ||= diagnostics.some((item) => item.severity === "error");
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, result.code, "utf8");
      if (options.mode === "compatible" && options.emitRuntime) runtimeDirectories.add(path.dirname(output));
      report.push({ input: file, output, mode: options.mode, diagnostics, stats: result.stats });
      const warningCount = diagnostics.filter((item) => item.severity === "warning").length;
      const errorCount = diagnostics.filter((item) => item.severity === "error").length;
      console.log(`${file} -> ${output} (${errorCount} errors, ${warningCount} warnings)`);
      for (const diagnostic of diagnostics) {
        const location = diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : "";
        console.log(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code}${location} ${diagnostic.message}`);
      }
    } catch (error) {
      hasErrors = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${file}: ${message}`);
      report.push({ input: file, output, mode: options.mode, failed: true, message });
    }
  }

  for (const directory of runtimeDirectories) {
    fs.writeFileSync(path.join(directory, RUNTIME_FILE_NAME), RUNTIME_SOURCE, "utf8");
  }
  if (options.report) {
    const reportPath = path.resolve(options.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(`Converted ${files.length} Lua file(s).`);
  return hasErrors ? 1 : 0;
}

process.exitCode = process.argv[2] === "analyze" ? runAnalysis(process.argv.slice(3))
  : process.argv[2] === "query" ? runQuery(process.argv.slice(3)) : main();
