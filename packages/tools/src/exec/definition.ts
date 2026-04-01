/**
 * exec 工具定义 — LLM 工具描述生成
 *
 * 根据环境快照动态生成 exec 工具的 ToolDefinition，
 * 描述中只包含当前系统可用的 runtime 及其示例。
 */

import { wrapTagFor } from "@n0n/shared";
import type { ToolDefinition } from "@n0n/types";
import type { EnvSnapshot } from "../env.ts";
import { getAvailableByGroup } from "../env.ts";

export { ExecArgsSchema } from "@n0n/types";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_RUNTIME = IS_WINDOWS ? "cmd" : "sh";

/** 各 runtime 的示例片段，按 runtime name 索引 */
const SHELL_EXAMPLES: Record<string, string[]> = {
	cmd: [
		"- `cmd` (Windows default): CLI commands, pipes, file operations",
		"  `dir /b src && type package.json | findstr version`",
		"  NOTE: Use `type` (not `cat`), `findstr` (not `grep`), `dir` (not `ls`)",
	],
	sh: [
		"- `sh` (Unix default): CLI commands, pipes, file operations",
		'  `ls -la src && grep "version" package.json`',
	],
	bash: [
		"- `bash`: advanced shell scripting (arrays, process substitution)",
		'  `for f in src/*.ts; do echo "$(wc -l < "$f") $f"; done | sort -rn | head -5`',
	],
	pwsh: [
		"- `pwsh` (PowerShell): cross-platform, object-oriented pipeline",
		"  `Get-ChildItem src -Recurse -Filter *.ts | Measure-Object | Select-Object -Expand Count`",
	],
};

const JS_EXAMPLES: Record<string, string[]> = {
	bun: [
		"- `bun` (TypeScript/JS, recommended): preprocess data, parse JSON, transform files",
		"  ```",
		'  import { readdir } from "node:fs/promises";',
		'  const files = await readdir("./src", { recursive: true });',
		'  const tsFiles = files.filter(f => f.endsWith(".ts"));',
		"  console.log('Found ' + tsFiles.length + ' TS files');",
		"  for (const f of tsFiles.slice(0, 10)) console.log(' - ' + f);",
		"  ```",
		"  **Advanced — one script replaces many shell round-trips:**",
		"  ```",
		"  import { readdir, readFile, stat } from 'node:fs/promises';",
		"  import { join, extname } from 'node:path';",
		"  async function tree(dir: string, prefix = ''): Promise<string[]> {",
		"    const entries = await readdir(dir, { withFileTypes: true });",
		"    const lines: string[] = [];",
		"    for (const e of entries) {",
		"      if (e.name.startsWith('.') || e.name === 'node_modules') continue;",
		"      const full = join(dir, e.name);",
		"      if (e.isDirectory()) {",
		"        lines.push(prefix + '📁 ' + e.name + '/');",
		"        lines.push(...await tree(full, prefix + '  '));",
		"      } else {",
		"        const s = await stat(full);",
		"        const lc = extname(e.name).match(/\\.(ts|js|py|md)$/) ? (await readFile(full,'utf8')).split('\\n').length : null;",
		"        lines.push(prefix + '📄 ' + e.name + ' (' + s.size + 'B' + (lc !== null ? ', '+lc+' lines' : '') + ')');",
		"      }",
		"    }",
		"    return lines;",
		"  }",
		"  console.log((await tree('src')).join('\\n'));",
		"  ```",
		"  **With libraries — install then use immediately:**",
		"  `bun add ts-morph` → then in the next exec call:",
		"  ```",
		"  import { Project } from 'ts-morph';",
		"  const p = new Project({ tsConfigFilePath: 'tsconfig.json' });",
		"  for (const sf of p.getSourceFiles()) {",
		"    const fns = sf.getFunctions().map(f => f.getName());",
		"    const cls = sf.getClasses().map(c => c.getName());",
		"    const imps = sf.getImportDeclarations().length;",
		"    if (fns.length || cls.length)",
		"      console.log(sf.getFilePath(), { functions: fns, classes: cls, imports: imps });",
		"  }",
		"  ```",
	],
	node: [
		"- `node` (Node.js, .mjs): JS runtime, similar to bun",
		"  ```",
		'  import { readdir } from "node:fs/promises";',
		'  const files = await readdir("./src", { recursive: true });',
		"  console.log(files.length + ' files found');",
		"  ```",
	],
	deno: [
		"- `deno` (TypeScript, --allow-all): secure-by-default runtime",
		"  ```",
		'  const entries = [...Deno.readDirSync("./src")];',
		"  console.log(entries.length + ' entries');",
		"  ```",
	],
};

const PYTHON_EXAMPLES: Record<string, string[]> = {
	python: [
		"- `python`: data analysis, scripting",
		"  ```",
		"  import json",
		'  data = json.load(open("package.json"))',
		'  deps = data.get("dependencies", {})',
		'  print(f"Dependencies ({len(deps)}):")',
		'  for k, v in sorted(deps.items()): print(f"  {k}: {v}")',
		"  ```",
		"  **Advanced — recursive project analysis in one call:**",
		"  ```",
		"  import os, json",
		"  stats = {'files': 0, 'lines': 0, 'by_ext': {}}",
		"  for root, dirs, files in os.walk('src'):",
		"      dirs[:] = [d for d in dirs if d not in ('node_modules', '.git', '__pycache__')]",
		"      for f in files:",
		"          ext = os.path.splitext(f)[1]",
		"          stats['files'] += 1",
		"          stats['by_ext'][ext] = stats['by_ext'].get(ext, 0) + 1",
		"          try:",
		"              with open(os.path.join(root, f), encoding='utf-8', errors='replace') as fh:",
		"                  stats['lines'] += len(fh.readlines())",
		"          except (OSError, UnicodeDecodeError) as e:",
		"              print(f'Warning: skipping {os.path.join(root, f)}: {e}', flush=True)",
		"  print(json.dumps(stats, indent=2))",
		"  ```",
		"  **With libraries — `pip install libcst` then analyze Python AST:**",
		"  ```",
		"  import libcst as cst, os, json",
		"  results = []",
		"  for root, _, files in os.walk('src'):",
		"      for f in [f for f in files if f.endswith('.py')]:",
		"          path = os.path.join(root, f)",
		"          with open(path, encoding='utf-8') as fh:",
		"              mod = cst.parse_module(fh.read())",
		"          classes = [n.name.value for n in mod.body if isinstance(n, cst.ClassDef)]",
		"          funcs = [n.name.value for n in mod.body if isinstance(n, cst.FunctionDef)]",
		"          if classes or funcs: results.append({'file': path, 'classes': classes, 'functions': funcs})",
		"  print(json.dumps(results, indent=2))",
		"  ```",
	],
	python3: [
		"- `python3`: same as python (use on systems where `python` is v2)",
	],
	uv: [
		"- `uv` (via `uv run python`): managed Python, no global install needed",
		"  ```",
		"  import sys",
		"  print(f'Python {sys.version}')",
		"  ```",
	],
};

const EXAMPLES_BY_GROUP: Record<string, Record<string, string[]>> = {
	shell: SHELL_EXAMPLES,
	js: JS_EXAMPLES,
	python: PYTHON_EXAMPLES,
};

/** 构建单个 runtime 组的描述块 */
function buildGroupBlock(
	label: string,
	key: "shell" | "js" | "python",
	env: EnvSnapshot,
	model: string,
): string | null {
	const available = getAvailableByGroup(env, key);
	if (available.length === 0) return null;

	const header = `${label} (${available.map((r) => `${r.name}${r.version ? ` ${r.version}` : ""}`).join(", ")})`;
	const examplesMap = EXAMPLES_BY_GROUP[key] ?? {};
	const body: string[] = [];
	for (const rt of available) {
		const ex = examplesMap[rt.name];
		if (ex) body.push(...ex);
	}
	return wrapTagFor(key, `${header}\n${body.join("\n")}`, model);
}

/** 根据环境快照构建 exec 工具描述（XML tag 结构化） */
function buildDescription(env: EnvSnapshot, model: string): string {
	const parts: string[] = [
		`Execute a script on ${env.os} (default shell: ${env.defaultShell}). Content is written to a temp file and run with the specified runtime. Returns stdout, stderr, and exit code.`,
	];

	const groups: { label: string; key: "shell" | "js" | "python" }[] = [
		{ label: "Shell runtimes", key: "shell" },
		{ label: "JS/TS runtimes", key: "js" },
		{ label: "Python runtimes", key: "python" },
	];

	for (const { label, key } of groups) {
		const block = buildGroupBlock(label, key, env, model);
		if (block) parts.push(block);
	}

	const preferredJs = getAvailableByGroup(env, "js")[0];
	const jsHint = preferredJs
		? `Use \`${preferredJs.name}\` runtime for complex logic`
		: "Use a language runtime for complex logic";

	const tips = [
		"- **Process output inside the script** — filter, summarize, format before printing. Avoid dumping large raw output.",
		`- **${jsHint}** — when you need to parse JSON, filter arrays, do math, or produce structured summaries, write a script instead of chaining shell commands.`,
		`- **Simple commands use default shell (\`${env.defaultShell}\`)** — \`git status\`, \`ls\`/\`dir\` don't need a language runtime.`,
		"- **Use libraries in isolation** — for deeper analysis, use proper libraries (e.g. AST/analysis tools) in a temporary or isolated environment (such as a throwaway directory or managed Python runner like `uv`). Avoid running `bun add` or `pip install` in the main project workspace unless you explicitly intend to update its dependencies.",
		"- **Debugging**: `2>&1` merges stderr; `> output.txt 2>&1` captures to file.",
	].join("\n");
	parts.push(wrapTagFor("best_practices", tips, model));

	return parts.join("\n");
}

/**
 * 根据环境快照动态生成 exec 工具的 LLM 定义。
 */
export function makeExecToolDefinition(
	env: EnvSnapshot,
	model = "",
): ToolDefinition {
	const available = env.runtimes.filter((r) => r.available);
	const runtimeList = available.map((r) => r.name).join(", ");

	return {
		name: "exec",
		description: buildDescription(env, model),
		parameters: {
			type: "object",
			properties: {
				script: {
					type: "string",
					description:
						"Script content. Single command or multi-line code with imports, loops, etc.",
				},
				runtime: {
					type: "string",
					description: `Runtime (default: "${DEFAULT_RUNTIME}"). Available: ${runtimeList}.`,
				},
				cwd: {
					type: "string",
					description: "Working directory (default: injected workspace root)",
				},
				timeout: {
					type: "number",
					description:
						"Timeout in seconds (default: 120). Process continues in background if exceeded.",
				},
			},
			required: ["script"],
			additionalProperties: false,
		},
	};
}
