import { parse } from "luaparse";
import type { ConvertOptions, ConvertResult, Diagnostic } from "./types.js";

type Node = any;

interface Context {
  indent: number;
  inFunction: boolean;
  selfAsThis: boolean;
}

const RUNTIME_IMPORTS = [
  "luaAnd",
  "luaClass",
  "luaConcat",
  "luaFirst",
  "luaGetmetatable",
  "luaIpairs",
  "luaIterator",
  "luaLen",
  "luaMulti",
  "luaNot",
  "luaNumericFor",
  "luaOr",
  "luaPairs",
  "luaRawget",
  "luaRawset",
  "luaSetmetatable",
  "luaTable",
  "luaTonumber",
  "luaTostring",
  "luaTruthy",
  "luaType",
  "luaSelect",
  "luaUnpack",
  "luaValues",
].join(", ");

const BUILTIN_CALLS: Record<string, string> = {
  getmetatable: "luaGetmetatable",
  rawget: "luaRawget",
  rawset: "luaRawset",
  setmetatable: "luaSetmetatable",
  tonumber: "luaTonumber",
  tostring: "luaTostring",
  type: "luaType",
  select: "luaSelect",
  unpack: "luaUnpack",
};

const LUA51_ENVIRONMENT_CALLS = new Set(["getfenv", "setfenv", "module", "loadstring", "newproxy"]);

export function convertLua(source: string, options: ConvertOptions): ConvertResult {
  const diagnostics: Diagnostic[] = [];
  const stats = { statements: 0, functions: 0, tables: 0 };
  const ast = parse(source, {
    luaVersion: "5.1",
    comments: true,
    locations: true,
    ranges: true,
  });
  const comments: Node[] = [...(ast.comments ?? [])].sort((a, b) => a.range[0] - b.range[0]);
  let commentIndex = 0;
  const compatible = options.mode === "compatible";
  const runtimeImport = options.runtimeImport ?? "./lua-runtime.js";

  function report(node: Node | undefined, severity: Diagnostic["severity"], code: string, message: string): void {
    diagnostics.push({
      severity,
      code,
      message,
      line: node?.loc?.start?.line,
      column: node?.loc?.start?.column != null ? node.loc.start.column + 1 : undefined,
    });
  }

  const pad = (level: number): string => "    ".repeat(level);
  const identifierName = (node: Node): string => node?.name ?? "unknown";
  const isIdentifier = (value: string): boolean => /^[A-Za-z_$][\w$]*$/.test(value);

  function decodeLuaString(raw: string): string {
    if (raw.startsWith("[")) {
      return raw.replace(/^\[=*\[\r?\n?/, "").replace(/\]=*\]$/, "");
    }
    const quote = raw[0];
    const input = raw.slice(1, -1);
    let result = "";
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (character !== "\\") {
        result += character;
        continue;
      }
      const next = input[++index];
      const escapes: Record<string, string> = {
        a: "\u0007", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\u000b",
        "\\": "\\", "\"": "\"", "'": "'",
      };
      if (next in escapes) result += escapes[next];
      else if (next === "\n") result += "\n";
      else if (next === "\r") {
        if (input[index + 1] === "\n") index += 1;
        result += "\n";
      } else if (next === "z") {
        while (/\s/.test(input[index + 1] ?? "")) index += 1;
      } else if (next === "x") {
        const hex = input.slice(index + 1, index + 3);
        result += String.fromCodePoint(Number.parseInt(hex, 16));
        index += 2;
      } else if (/\d/.test(next)) {
        const match = input.slice(index).match(/^\d{1,3}/)?.[0] ?? next;
        result += String.fromCodePoint(Number.parseInt(match, 10));
        index += match.length - 1;
      } else {
        result += next ?? "";
      }
    }
    void quote;
    return result;
  }

  function renderComment(comment: Node, indent: number): string {
    const prefix = pad(indent);
    const raw: string = comment.raw ?? "";
    if (raw.startsWith("--[[") || /^--\[=+\[/.test(raw)) {
      const content = raw.replace(/^--\[=*\[/, "").replace(/\]=*\]$/, "");
      return `${prefix}/*${content.replace(/\*\//g, "* /")}*/\n`;
    }
    return `${prefix}//${raw.startsWith("--") ? raw.slice(2) : raw}\n`;
  }

  function leadingComments(line: number, indent: number): string {
    let result = "";
    while (commentIndex < comments.length && comments[commentIndex].loc.start.line <= line) {
      result += renderComment(comments[commentIndex], indent);
      commentIndex += 1;
    }
    return result;
  }

  function property(base: string, key: string): string {
    return isIdentifier(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
  }

  function tableExpression(node: Node, context: Context): string {
    stats.tables += 1;
    if (compatible) {
      const fields = node.fields.map((field: Node) => {
        if (field.type === "TableValue") return `{ kind: "value", value: ${expression(field.value, context)} }`;
        if (field.type === "TableKeyString") {
          return `{ kind: "key", key: ${JSON.stringify(identifierName(field.key))}, value: ${expression(field.value, context)} }`;
        }
        return `{ kind: "key", key: ${expression(field.key, context)}, value: ${expression(field.value, context)} }`;
      });
      return `luaTable([${fields.join(", ")}])`;
    }

    const allValues = node.fields.every((field: Node) => field.type === "TableValue");
    if (allValues) {
      return `[undefined${node.fields.length ? ", " : ""}${node.fields.map((field: Node) => expression(field.value, context)).join(", ")}]`;
    }
    let implicit = 1;
    const fields = node.fields.map((field: Node) => {
      if (field.type === "TableValue") return `${implicit++}: ${expression(field.value, context)}`;
      if (field.type === "TableKeyString") {
        const key = identifierName(field.key);
        return `${isIdentifier(key) ? key : JSON.stringify(key)}: ${expression(field.value, context)}`;
      }
      return `[${expression(field.key, context)}]: ${expression(field.value, context)}`;
    });
    return `{ ${fields.join(", ")} }`;
  }

  function functionExpression(node: Node, context: Context): string {
    stats.functions += 1;
    const parameters = renderParameters(node.parameters ?? []);
    const inner = { ...context, indent: context.indent + 1, inFunction: true };
    return `(${parameters}) => {\n${body(node.body, inner)}${pad(context.indent)}}`;
  }

  function renderParameters(parameters: Node[]): string {
    return parameters.map((parameter) =>
      parameter.type === "VarargLiteral" ? "...luaArgs: any[]" : `${identifierName(parameter)}: any`
    ).join(", ");
  }

  function callExpression(node: Node, context: Context): string {
    let base = expression(node.base, context);
    if (node.base.type === "Identifier" && LUA51_ENVIRONMENT_CALLS.has(node.base.name)) {
      report(
        node,
        "warning",
        "LUA2TS_LUA51_ENVIRONMENT",
        `Lua 5.1 ${node.base.name}() depends on interpreter environment behavior and requires a project-specific adapter.`,
      );
    }
    if (compatible && node.base.type === "Identifier" && BUILTIN_CALLS[node.base.name]) {
      base = BUILTIN_CALLS[node.base.name];
    }
    const args = (node.arguments ?? []).map((argument: Node) => expression(argument, context)).join(", ");
    return `${base}(${args})`;
  }

  function expression(node: Node, context: Context): string {
    if (!node) return "undefined";
    switch (node.type) {
      case "Identifier":
        return context.selfAsThis && node.name === "self" ? "this" : node.name;
      case "NilLiteral": return "undefined";
      case "BooleanLiteral": return String(node.value);
      case "NumericLiteral": return node.raw;
      case "StringLiteral": return JSON.stringify(decodeLuaString(node.raw));
      case "VarargLiteral": return "...luaArgs";
      case "TableConstructorExpression": return tableExpression(node, context);
      case "MemberExpression": {
        const base = expression(node.base, context);
        return property(base, identifierName(node.identifier));
      }
      case "IndexExpression": return `${expression(node.base, context)}[${expression(node.index, context)}]`;
      case "FunctionDeclaration": return functionExpression(node, context);
      case "CallExpression": return callExpression(node, context);
      case "TableCallExpression": return `${expression(node.base, context)}(${tableExpression(node.arguments, context)})`;
      case "StringCallExpression": return `${expression(node.base, context)}(${expression(node.argument, context)})`;
      case "UnaryExpression": {
        const value = expression(node.argument, context);
        if (node.operator === "not") return compatible ? `luaNot(${value})` : `!(${value})`;
        if (node.operator === "#") return compatible ? `luaLen(${value})` : `(${value}).length`;
        return `${node.operator}(${value})`;
      }
      case "LogicalExpression": {
        const left = expression(node.left, context);
        const right = expression(node.right, context);
        if (compatible) {
          return node.operator === "and"
            ? `luaAnd(() => ${left}, () => ${right})`
            : `luaOr(() => ${left}, () => ${right})`;
        }
        return `(${left} ${node.operator === "and" ? "&&" : "||"} ${right})`;
      }
      case "BinaryExpression": {
        const left = expression(node.left, context);
        const right = expression(node.right, context);
        if (compatible && node.operator === "..") return `luaConcat(${left}, ${right})`;
        const operators: Record<string, string> = { "~=": "!==", "==": "===", "..": "+", "^": "**" };
        return `(${left} ${operators[node.operator] ?? node.operator} ${right})`;
      }
      default:
        report(node, "error", "LUA2TS_UNSUPPORTED_EXPRESSION", `Unsupported expression node: ${node.type}`);
        return `undefined /* unsupported ${node.type} */`;
    }
  }

  function condition(node: Node, context: Context): string {
    const value = expression(node, context);
    return compatible ? `luaTruthy(${value})` : value;
  }

  function isClassDeclaration(node: Node): boolean {
    return node.type === "LocalStatement"
      && node.variables?.length === 1
      && node.init?.length === 1
      && node.init[0].type === "CallExpression"
      && node.init[0].base?.type === "Identifier"
      && node.init[0].base.name === "class";
  }

  function classDeclaration(node: Node, context: Context): string {
    const name = identifierName(node.variables[0]);
    const args = node.init[0].arguments ?? [];
    const className = args[0] ? expression(args[0], context) : JSON.stringify(name);
    const base = args[1] ? expression(args[1], context) : undefined;
    if (compatible) return `${pad(context.indent)}const ${name} = luaClass(${className}${base ? `, ${base}` : ""});\n`;
    return `${pad(context.indent)}class ${name}${base ? ` extends ${base}` : ""} {}\n`;
  }

  function assignmentValues(values: Node[], wanted: number, context: Context): string {
    const rendered = values.map((value) => expression(value, context));
    if (compatible) return `luaValues([${rendered.join(", ")}], ${wanted})`;
    return `[${rendered.join(", ")}]`;
  }

  function functionTarget(node: Node, context: Context): { target: string; selfAsThis: boolean } | undefined {
    const id = node.identifier;
    if (!id || id.type === "Identifier") return undefined;
    if (id.type === "MemberExpression" && id.indexer === ":") {
      return {
        target: property(`${expression(id.base, context)}.prototype`, identifierName(id.identifier)),
        selfAsThis: true,
      };
    }
    return { target: expression(id, context), selfAsThis: false };
  }

  function statement(node: Node, context: Context): string {
    stats.statements += 1;
    const p = pad(context.indent);
    let output = leadingComments(node.loc?.start?.line ?? Number.MAX_SAFE_INTEGER, context.indent);
    switch (node.type) {
      case "LocalStatement": {
        if (isClassDeclaration(node)) return output + classDeclaration(node, context);
        if (node.variables.length === 1 && node.init.length <= 1) {
          return output + `${p}var ${expression(node.variables[0], context)}${node.init[0] ? ` = ${compatible ? `luaFirst(${expression(node.init[0], context)})` : expression(node.init[0], context)}` : ""};\n`;
        }
        const variables = node.variables.map((variable: Node) => expression(variable, context));
        output += `${p}var [${variables.join(", ")}] = ${assignmentValues(node.init, variables.length, context)};\n`;
        return output;
      }
      case "AssignmentStatement": {
        const variables = node.variables.map((variable: Node) => expression(variable, context));
        if (variables.length === 1 && node.init.length === 1) {
          return output + `${p}${variables[0]} = ${compatible ? `luaFirst(${expression(node.init[0], context)})` : expression(node.init[0], context)};\n`;
        }
        return output + `${p}[${variables.join(", ")}] = ${assignmentValues(node.init, variables.length, context)};\n`;
      }
      case "CallStatement": return output + `${p}${expression(node.expression, context)};\n`;
      case "ReturnStatement": {
        if (!context.inFunction) {
          if (node.arguments.length === 1) return output + `${p}export default ${expression(node.arguments[0], context)};\n`;
          report(node, "error", "LUA2TS_TOP_LEVEL_RETURN", "Top-level return with zero or multiple values needs manual module export handling.");
          return output + `${p}// TODO(lua2ts): unsupported top-level return\n`;
        }
        if (!node.arguments.length) return output + `${p}return;\n`;
        if (node.arguments.length === 1) return output + `${p}return ${expression(node.arguments[0], context)};\n`;
        const values = node.arguments.map((argument: Node) => expression(argument, context));
        return output + `${p}return ${compatible ? `luaMulti([${values.join(", ")}])` : `[${values.join(", ")}]`};\n`;
      }
      case "BreakStatement": return output + `${p}break;\n`;
      case "GotoStatement":
        report(node, "error", "LUA2TS_GOTO", "Lua goto has no direct TypeScript equivalent.");
        return output + `${p}// TODO(lua2ts): goto ${identifierName(node.label)}\n`;
      case "LabelStatement":
        report(node, "warning", "LUA2TS_LABEL", "Lua labels are emitted as comments because goto is unsupported.");
        return output + `${p}// ::${identifierName(node.label)}::\n`;
      case "FunctionDeclaration": {
        stats.functions += 1;
        const target = functionTarget(node, context);
        const parameters = renderParameters(node.parameters ?? []);
        if (target) {
          const inner = { indent: context.indent + 1, inFunction: true, selfAsThis: target.selfAsThis || context.selfAsThis };
          output += `${p}${target.target} = function (this: any${parameters ? `, ${parameters}` : ""}) {\n`;
          output += body(node.body, inner);
          return output + `${p}};\n`;
        }
        const name = identifierName(node.identifier);
        if (node.isLocal) {
          const inner = { indent: context.indent + 1, inFunction: true, selfAsThis: context.selfAsThis };
          output += `${p}const ${name} = (${parameters}) => {\n${body(node.body, inner)}${p}};\n`;
          return output;
        }
        const inner = { indent: context.indent + 1, inFunction: true, selfAsThis: false };
        output += `${p}function ${name}(${parameters}) {\n${body(node.body, inner)}${p}}\n`;
        return output;
      }
      case "IfStatement": {
        node.clauses.forEach((clause: Node, index: number) => {
          if (clause.type === "IfClause") output += `${p}if (${condition(clause.condition, context)}) {\n`;
          else if (clause.type === "ElseifClause") output += `${p}} else if (${condition(clause.condition, context)}) {\n`;
          else output += `${p}} else {\n`;
          output += body(clause.body, { ...context, indent: context.indent + 1 });
          void index;
        });
        return output + `${p}}\n`;
      }
      case "WhileStatement": {
        output += `${p}while (${condition(node.condition, context)}) {\n`;
        output += body(node.body, { ...context, indent: context.indent + 1 });
        return output + `${p}}\n`;
      }
      case "RepeatStatement": {
        output += `${p}do {\n${body(node.body, { ...context, indent: context.indent + 1 })}`;
        return output + `${p}} while (!(${condition(node.condition, context)}));\n`;
      }
      case "DoStatement": {
        output += `${p}{\n${body(node.body, { ...context, indent: context.indent + 1 })}`;
        return output + `${p}}\n`;
      }
      case "ForNumericStatement": {
        const variable = identifierName(node.variable);
        if (compatible) {
          output += `${p}for (const ${variable} of luaNumericFor(${expression(node.start, context)}, ${expression(node.end, context)}, ${node.step ? expression(node.step, context) : "1"})) {\n`;
        } else {
          const step = node.step ? expression(node.step, context) : "1";
          output += `${p}for (let ${variable} = ${expression(node.start, context)}, __luaStep = ${step}; __luaStep > 0 ? ${variable} <= ${expression(node.end, context)} : ${variable} >= ${expression(node.end, context)}; ${variable} += __luaStep) {\n`;
        }
        output += body(node.body, { ...context, indent: context.indent + 1 });
        return output + `${p}}\n`;
      }
      case "ForGenericStatement": {
        const variables = node.variables.map((variable: Node) => identifierName(variable)).join(", ");
        const first = node.iterators[0];
        let iterator: string;
        if (compatible && first?.type === "CallExpression" && first.base?.type === "Identifier" && first.base.name === "pairs") {
          iterator = `luaPairs(${expression(first.arguments[0], context)})`;
        } else if (compatible && first?.type === "CallExpression" && first.base?.type === "Identifier" && first.base.name === "ipairs") {
          iterator = `luaIpairs(${expression(first.arguments[0], context)})`;
        } else {
          iterator = `luaIterator(${node.iterators.map((item: Node) => expression(item, context)).join(", ")})`;
          report(node, "warning", "LUA2TS_GENERIC_ITERATOR", "Generic iterator may require a project-specific runtime adapter.");
        }
        output += `${p}for (const [${variables}] of ${iterator}) {\n`;
        output += body(node.body, { ...context, indent: context.indent + 1 });
        return output + `${p}}\n`;
      }
      default:
        report(node, "error", "LUA2TS_UNSUPPORTED_STATEMENT", `Unsupported statement node: ${node.type}`);
        return output + `${p}// TODO(lua2ts): unsupported ${node.type}\n`;
    }
  }

  function body(nodes: Node[], context: Context): string {
    return nodes.map((node) => statement(node, context)).join("");
  }

  let code = `/* Generated from ${options.sourceName ?? "Lua source"} by lua2ts-offline (${options.mode} mode). */\n`;
  if (compatible) code += `import { ${RUNTIME_IMPORTS} } from ${JSON.stringify(runtimeImport)};\n\n`;
  else code += "declare function luaIterator(...values: any[]): Iterable<any[]>;\n\n";
  code += body(ast.body, { indent: 0, inFunction: false, selfAsThis: false });
  while (commentIndex < comments.length) code += renderComment(comments[commentIndex++], 0);

  return { code, diagnostics, stats };
}
