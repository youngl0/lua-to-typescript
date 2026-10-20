export type ConversionMode = "syntax" | "compatible";

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  line?: number;
  column?: number;
}

export interface ConvertOptions {
  mode: ConversionMode;
  sourceName?: string;
  runtimeImport?: string;
}

export interface ConvertResult {
  code: string;
  diagnostics: Diagnostic[];
  stats: {
    statements: number;
    functions: number;
    tables: number;
  };
}
