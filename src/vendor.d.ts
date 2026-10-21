declare module "luaparse" {
  export interface ParseOptions {
    luaVersion?: "5.1" | "5.2" | "5.3" | "LuaJIT";
    comments?: boolean;
    locations?: boolean;
    ranges?: boolean;
    scope?: boolean;
  }

  export function parse(source: string, options?: ParseOptions): any;
}
