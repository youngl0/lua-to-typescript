import { parse } from "luaparse";
import type { AnalysisLuaVersion } from "./analysis-types.js";

/** Analysis accepts legacy dialects without rewriting source, ranges, or shared parser defaults. */
export function parseAnalysisSource(source: string): { ast: any; parseMode: AnalysisLuaVersion } {
  let firstError: unknown;
  for (const parseMode of ["5.1", "LuaJIT", "5.2"] as const) {
    try {
      const ast = parse(source, { luaVersion: parseMode, scope: true, locations: true, ranges: true, comments: false });
      return { ast, parseMode };
    } catch (error) {
      firstError ??= error;
    }
  }
  // Preserve the original diagnostic if none of the supported dialects can parse the file.
  throw firstError;
}
