import fs from "node:fs";
import type { AnalysisDatabase } from "./analysis-types.js";

/** Read/validate a saved snapshot without scanning or parsing Lua source. */
export function readAnalysisDatabase(file: string): AnalysisDatabase {
  const database = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as AnalysisDatabase;
  if (database?.schemaVersion !== 1) throw new Error(`Unsupported analysis schema in ${file}; expected schemaVersion 1.`);
  if (!database.files || typeof database.files !== "object" || Array.isArray(database.files)
    || typeof database.root !== "string" || !database.config
    || !Array.isArray(database.config.loaders) || !Array.isArray(database.config.modulePaths)
    || database.config.loaders.some((item) => typeof item !== "string")
    || database.config.modulePaths.some((item) => typeof item !== "string")
    || !Array.isArray(database.globals) || !Array.isArray(database.dependencies)
    || !database.annotations || typeof database.annotations !== "object" || Array.isArray(database.annotations)) {
    throw new Error(`Invalid analysis database: ${file}. Restore a valid database or use a new --db path.`);
  }
  for (const [name, record] of Object.entries(database.files)) {
    if (!record || typeof record.hash !== "string" || !Array.isArray(record.globals)
      || !Array.isArray(record.modules) || !Array.isArray(record.diagnostics)) throw new Error(`Invalid file record: ${name}`);
  }
  for (const symbol of database.globals) {
    if (!symbol || typeof symbol.name !== "string" || !["defined", "builtin", "external"].includes(symbol.status)
      || !Array.isArray(symbol.definitions) || !Array.isArray(symbol.references)) throw new Error("Invalid global symbol record.");
  }
  for (const edge of database.dependencies) {
    if (!edge || !Object.hasOwn(database.files, edge.from) || !Object.hasOwn(database.files, edge.to)
      || !["load", "global"].includes(edge.kind)) throw new Error("Invalid dependency edge.");
  }
  return database;
}
