# Tool Definition: exec
<!-- generated for model: claude-sonnet-4-20250514 -->

## parameters

```json
{
  "type": "object",
  "properties": {
    "script": {
      "type": "string",
      "description": "Script content. Single command or multi-line code with imports, loops, etc."
    },
    "runtime": {
      "description": "Runtime (default: \"cmd\"). Available: cmd, pwsh, bun, node, uv.",
      "type": "string"
    },
    "cwd": {
      "description": "Working directory (default: injected workspace root)",
      "type": "string"
    },
    "waitfor": {
      "description": "Max seconds to wait for process (default: 120, max: 240). Process continues in background if exceeded.",
      "type": "number",
      "maximum": 240
    }
  },
  "required": [
    "script"
  ],
  "additionalProperties": false
}
```

## description

````
Execute a script on windows (default shell: cmd). Content is written to a temp file and run with the specified runtime. Returns stdout, stderr, and exit code.
<shell>
Shell runtimes (cmd 10.0.26100.8246, pwsh 7.6.0)
### `cmd` (Windows default): CLI commands, pipes, file operations
`dir /b src && type package.json | findstr version`
NOTE: Use `type` (not `cat`), `findstr` (not `grep`), `dir` (not `ls`)
### `pwsh` (PowerShell): cross-platform, object-oriented pipeline
`Get-ChildItem src -Recurse -Filter *.ts | Measure-Object | Select-Object -Expand Count`
</shell>
<js>
JS/TS runtimes (bun 1.3.6, node 24.8.0)
### `bun` (TypeScript/JS, recommended): preprocess data, parse JSON, transform files
```
import { readdir } from "node:fs/promises";
const files = await readdir("./src", { recursive: true });
const tsFiles = files.filter(f => f.endsWith(".ts"));
console.log('Found ' + tsFiles.length + ' TS files');
for (const f of tsFiles.slice(0, 10)) console.log(' - ' + f);
```
**Advanced — one script replaces many shell round-trips:**
```
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
async function tree(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const lines: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      lines.push(prefix + '📁 ' + e.name + '/');
      lines.push(...await tree(full, prefix + '  '));
    } else {
      const s = await stat(full);
      const lc = extname(e.name).match(/\.(ts|js|py|md)$/) ? (await readFile(full,'utf8')).split('\n').length : null;
      lines.push(prefix + '📄 ' + e.name + ' (' + s.size + 'B' + (lc !== null ? ', '+lc+' lines' : '') + ')');
    }
  }
  return lines;
}
console.log((await tree('src')).join('\n'));
```
**With libraries — install then use immediately:**
Only `node:*` built-in modules work out of the box. Third-party packages must be installed first (`bun add <pkg>` in a separate exec call) before importing.
`bun add ts-morph` → then in the next exec call:
```
import { Project } from 'ts-morph';
const p = new Project({ tsConfigFilePath: 'tsconfig.json' });
for (const sf of p.getSourceFiles()) {
  const fns = sf.getFunctions().map(f => f.getName());
  const cls = sf.getClasses().map(c => c.getName());
  const imps = sf.getImportDeclarations().length;
  if (fns.length || cls.length)
    console.log(sf.getFilePath(), { functions: fns, classes: cls, imports: imps });
}
```
### `node` (Node.js, .mjs): JS runtime, similar to bun
```
import { readdir } from "node:fs/promises";
const files = await readdir("./src", { recursive: true });
console.log(files.length + ' files found');
```
**Note:** Only `node:*` built-in modules are available by default. Third-party packages require installation via the project's package manager (e.g. `npm install <pkg>`) before importing.
</js>
<python>
Python runtimes (uv 0.8.14)
### `uv` (via `uv run`): managed Python, no global install needed
```
import sys
print(f'Python {sys.version}')
```
**With libraries — use PEP 723 inline metadata (no separate install step):**
```
# /// script
# dependencies = ["requests"]
# ///
import requests
r = requests.get("https://api.github.com/repos/python/cpython")
print(r.json()["stargazers_count"], "stars")
```
</python>
<best_practices>
- **Prefer `write` and `edit` for file operations** — they are more efficient and easier to review than shell commands. Use `exec` for batch operations (bulk renames, bulk replacements) or when you need shell-specific functionality.
- **Process output inside the script** — filter, summarize, format before printing. Avoid dumping large raw output.
- **Output truncation** — stdout+stderr exceeding ~4 000 tokens is auto-truncated: only the **last ~1 000 tokens** are kept and the full output is saved to a file. To avoid losing important content, **assess first** (`dir`) then read selectively (`findstr`, `powershell Select-String`) or split across parallel tool calls.
- **Prefer `rg` (ripgrep) over `grep`** — `rg` is faster, respects `.gitignore`, and supports recursive search by default. Use `rg "pattern" path/` instead of `grep -r "pattern" path/`.
- **Use `bun` runtime for complex logic** — when you need to parse JSON, filter arrays, do math, or produce structured summaries, write a script instead of chaining shell commands.
- **Simple commands use default shell (`cmd`)** — `git status`, `ls`/`dir` don't need a language runtime.
- **Use libraries in isolation** — for deeper analysis, use proper libraries (e.g. AST/analysis tools) in a temporary or isolated environment (such as a throwaway directory or managed Python runner like `uv`). Avoid running `bun add` or `pip install` in the main project workspace unless you explicitly intend to update its dependencies.
- **Debugging**: `2>&1` merges stderr; `> output.txt 2>&1` captures to file.
</best_practices>
````

## Full OpenAI function format

```json
{
  "type": "function",
  "function": {
    "name": "exec",
    "description": "Execute a script on windows (default shell: cmd). Content is written to a temp file and run with the specified runtime. Returns stdout, stderr, and exit code.\n<shell>\nShell runtimes (cmd 10.0.26100.8246, pwsh 7.6.0)\n### `cmd` (Windows default): CLI commands, pipes, file operations\n`dir /b src && type package.json | findstr version`\nNOTE: Use `type` (not `cat`), `findstr` (not `grep`), `dir` (not `ls`)\n### `pwsh` (PowerShell): cross-platform, object-oriented pipeline\n`Get-ChildItem src -Recurse -Filter *.ts | Measure-Object | Select-Object -Expand Count`\n</shell>\n<js>\nJS/TS runtimes (bun 1.3.6, node 24.8.0)\n### `bun` (TypeScript/JS, recommended): preprocess data, parse JSON, transform files\n```\nimport { readdir } from \"node:fs/promises\";\nconst files = await readdir(\"./src\", { recursive: true });\nconst tsFiles = files.filter(f => f.endsWith(\".ts\"));\nconsole.log('Found ' + tsFiles.length + ' TS files');\nfor (const f of tsFiles.slice(0, 10)) console.log(' - ' + f);\n```\n**Advanced — one script replaces many shell round-trips:**\n```\nimport { readdir, readFile, stat } from 'node:fs/promises';\nimport { join, extname } from 'node:path';\nasync function tree(dir: string, prefix = ''): Promise<string[]> {\n  const entries = await readdir(dir, { withFileTypes: true });\n  const lines: string[] = [];\n  for (const e of entries) {\n    if (e.name.startsWith('.') || e.name === 'node_modules') continue;\n    const full = join(dir, e.name);\n    if (e.isDirectory()) {\n      lines.push(prefix + '📁 ' + e.name + '/');\n      lines.push(...await tree(full, prefix + '  '));\n    } else {\n      const s = await stat(full);\n      const lc = extname(e.name).match(/\\.(ts|js|py|md)$/) ? (await readFile(full,'utf8')).split('\\n').length : null;\n      lines.push(prefix + '📄 ' + e.name + ' (' + s.size + 'B' + (lc !== null ? ', '+lc+' lines' : '') + ')');\n    }\n  }\n  return lines;\n}\nconsole.log((await tree('src')).join('\\n'));\n```\n**With libraries — install then use immediately:**\nOnly `node:*` built-in modules work out of the box. Third-party packages must be installed first (`bun add <pkg>` in a separate exec call) before importing.\n`bun add ts-morph` → then in the next exec call:\n```\nimport { Project } from 'ts-morph';\nconst p = new Project({ tsConfigFilePath: 'tsconfig.json' });\nfor (const sf of p.getSourceFiles()) {\n  const fns = sf.getFunctions().map(f => f.getName());\n  const cls = sf.getClasses().map(c => c.getName());\n  const imps = sf.getImportDeclarations().length;\n  if (fns.length || cls.length)\n    console.log(sf.getFilePath(), { functions: fns, classes: cls, imports: imps });\n}\n```\n### `node` (Node.js, .mjs): JS runtime, similar to bun\n```\nimport { readdir } from \"node:fs/promises\";\nconst files = await readdir(\"./src\", { recursive: true });\nconsole.log(files.length + ' files found');\n```\n**Note:** Only `node:*` built-in modules are available by default. Third-party packages require installation via the project's package manager (e.g. `npm install <pkg>`) before importing.\n</js>\n<python>\nPython runtimes (uv 0.8.14)\n### `uv` (via `uv run`): managed Python, no global install needed\n```\nimport sys\nprint(f'Python {sys.version}')\n```\n**With libraries — use PEP 723 inline metadata (no separate install step):**\n```\n# /// script\n# dependencies = [\"requests\"]\n# ///\nimport requests\nr = requests.get(\"https://api.github.com/repos/python/cpython\")\nprint(r.json()[\"stargazers_count\"], \"stars\")\n```\n</python>\n<best_practices>\n- **Prefer `write` and `edit` for file operations** — they are more efficient and easier to review than shell commands. Use `exec` for batch operations (bulk renames, bulk replacements) or when you need shell-specific functionality.\n- **Process output inside the script** — filter, summarize, format before printing. Avoid dumping large raw output.\n- **Output truncation** — stdout+stderr exceeding ~4 000 tokens is auto-truncated: only the **last ~1 000 tokens** are kept and the full output is saved to a file. To avoid losing important content, **assess first** (`dir`) then read selectively (`findstr`, `powershell Select-String`) or split across parallel tool calls.\n- **Prefer `rg` (ripgrep) over `grep`** — `rg` is faster, respects `.gitignore`, and supports recursive search by default. Use `rg \"pattern\" path/` instead of `grep -r \"pattern\" path/`.\n- **Use `bun` runtime for complex logic** — when you need to parse JSON, filter arrays, do math, or produce structured summaries, write a script instead of chaining shell commands.\n- **Simple commands use default shell (`cmd`)** — `git status`, `ls`/`dir` don't need a language runtime.\n- **Use libraries in isolation** — for deeper analysis, use proper libraries (e.g. AST/analysis tools) in a temporary or isolated environment (such as a throwaway directory or managed Python runner like `uv`). Avoid running `bun add` or `pip install` in the main project workspace unless you explicitly intend to update its dependencies.\n- **Debugging**: `2>&1` merges stderr; `> output.txt 2>&1` captures to file.\n</best_practices>",
    "parameters": {
      "type": "object",
      "properties": {
        "script": {
          "type": "string",
          "description": "Script content. Single command or multi-line code with imports, loops, etc."
        },
        "runtime": {
          "description": "Runtime (default: \"cmd\"). Available: cmd, pwsh, bun, node, uv.",
          "type": "string"
        },
        "cwd": {
          "description": "Working directory (default: injected workspace root)",
          "type": "string"
        },
        "waitfor": {
          "description": "Max seconds to wait for process (default: 120, max: 240). Process continues in background if exceeded.",
          "type": "number",
          "maximum": 240
        }
      },
      "required": [
        "script"
      ],
      "additionalProperties": false
    }
  }
}
```
