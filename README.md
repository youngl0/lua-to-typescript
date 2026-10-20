# lua2ts-offline

Deterministic, offline Lua 5.1 to TypeScript transpiler. Conversion does not call an AI service.

## Install and build

```powershell
npm install
npm run build
```

## Usage

```powershell
node dist/cli.js input.lua --mode compatible
node dist/cli.js input.lua -o output.ts --mode syntax
node dist/cli.js ./lua-source -o ./typescript-output --report ./conversion-report.json
```

`compatible` mode emits `lua-runtime.ts` beside generated files and preserves common Lua behavior such as truthiness, 1-based tables, `pairs`, `ipairs`, multiple returns, and the common `class(name, base)` pattern.

`syntax` mode produces simpler TypeScript-shaped output. It is intended for subsequent manual refactoring and does not preserve every Lua runtime semantic.

The parser is fixed to the Lua 5.1 grammar. Lua 5.2/5.3-only syntax such as `goto`, labels, integer division, and native bitwise operators is rejected during parsing.

The converter reports constructs that cannot be translated safely. In particular, Lua 5.1 environment functions (`setfenv`, `getfenv`, `module`, `loadstring`), project-specific generic iterators, native userdata, and framework-specific module loading may require adapters or manual migration. Lua 5.1 `unpack` and `select` are provided by the compatibility runtime.
