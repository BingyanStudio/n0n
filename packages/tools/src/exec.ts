/**
 * exec 工具 — 脚本执行
 *
 * 模型提供 script（脚本内容）和 runtime（执行运行时），
 * 工具将脚本写入临时文件后用指定运行时执行。
 * 所有平台行为一致，彻底消除 shell 引号转义问题。
 *
 * runtime 按用途分组，同组内有优先级：
 * - Shell 类：cmd(Win) / sh(Unix), bash, pwsh
 * - JS/TS 类：bun > node > deno
 * - Python 类：python > python3 > uv
 * - 默认：平台 shell（Windows: cmd, 其他: sh）
 *
 * 工具描述由 makeExecToolDefinition() 动态生成，
 * 基于 env.ts 探测结果，只展示当前系统可用的 runtime。
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { wrapTagFor } from "@n0n/shared";
import type {
	ExecToolCall,
	ExecToolResult,
	LLMToolDefinition,
	ToolOutputChunk,
	ToolStreamEvent,
} from "@n0n/types";
import type { EnvSnapshot } from "./env.ts";
import { getAvailableByGroup } from "./env.ts";

export { ExecArgsSchema } from "@n0n/types";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_RUNTIME = IS_WINDOWS ? "cmd" : "sh";

/** runtime → 临时文件扩展名 */
const RUNTIME_EXT: Record<string, string> = {
	sh: ".sh",
	bash: ".sh",
	cmd: ".cmd",
	pwsh: ".ps1",
	bun: ".ts",
	node: ".mjs",
	deno: ".ts",
	python: ".py",
	python3: ".py",
	uv: ".py",
};

/** runtime → 执行命令构造器 */
function buildSpawnCmd(runtime: string, tmpFile: string): string[] {
	switch (runtime) {
		case "cmd":
			return ["cmd", "/c", tmpFile];
		case "sh":
		case "bash":
			return [runtime, tmpFile];
		case "pwsh":
			return ["pwsh", "-NoProfile", "-File", tmpFile];
		case "bun":
			return ["bun", "run", tmpFile];
		case "node":
			return ["node", tmpFile];
		case "deno":
			return ["deno", "run", "--allow-all", tmpFile];
		case "python":
		case "python3":
			return [runtime, tmpFile];
		case "uv":
			return ["uv", "run", "python", tmpFile];
		default:
			// 未知 runtime 当作可执行文件名处理
			return [runtime, tmpFile];
	}
}

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
/** 根据环境快照构建 exec 工具描述 */
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

	// Best practices
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
 * 描述中只包含当前系统可用的 runtime 及其示例，使用 XML tag 结构化。
 *
 * @param env 环境快照（来自 detectEnv）
 * @param model LLM 模型名称（用于选择 tag 风格）
 */
export function makeExecToolDefinition(
	env: EnvSnapshot,
	model = "",
): LLMToolDefinition {
	const available = env.runtimes.filter((r) => r.available);
	const runtimeList = available.map((r) => r.name).join(", ");

	return {
		type: "function",
		function: {
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
		},
	};
}
function extractCommandNames(script: string): string[] {
	const parts = script.split(/\r?\n|&&|\|\||;|\||&/);
	return parts
		.map((part) => {
			const tokens = part.trim().split(/\s+/);
			const firstNonAssign = tokens.find(
				(t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t),
			);
			return firstNonAssign ?? "";
		})
		.filter((name) => name.length > 0);
}

function findBlockedCommand(
	script: string,
	blockedCommands: string[],
): string | null {
	const blocked = blockedCommands;
	if (blocked.length === 0) return null;
	const blockedNormalized = IS_WINDOWS
		? blocked.map((b) => b.toLowerCase())
		: blocked;
	const names = extractCommandNames(script);
	for (const name of names) {
		const basename = name.split(/[\\/]/).at(-1) ?? name;
		const basenameNormalized = IS_WINDOWS ? basename.toLowerCase() : basename;
		if (blockedNormalized.includes(basenameNormalized)) return basename;
	}
	return null;
}

async function handleBlockedCommand(
	call: ExecToolCall,
	_cwd: string,
	blockedCmd: string,
	confirmFn?: (question: string) => Promise<string>,
): Promise<ExecToolResult | null> {
	const runtime = call.args.runtime ?? DEFAULT_RUNTIME;
	if (confirmFn) {
		const safeScript = [...call.args.script]
			.map((ch) => {
				const code = ch.charCodeAt(0);
				if (code > 31 && code !== 127) return ch;
				if (ch === "\n") return "↵";
				if (ch === "\t") return "→";
				return `[^${String.fromCharCode(code + 64)}]`;
			})
			.join("");
		const answer = await confirmFn(
			`\n⚠  Script requires review: '${blockedCmd}' is in BLOCKED_COMMANDS\n` +
				`   Runtime: ${runtime}\n` +
				`   Script: ${safeScript}\n` +
				`   Allow execution? [y/N] `,
		);
		const normalized = answer.trim().toLowerCase();
		if (normalized !== "y" && normalized !== "yes") {
			return {
				type: "tool_result",
				tool: "exec" as const,
				call,
				exitCode: 1,
				stdout: "",
				stderr: `Command '${blockedCmd}' was rejected by the user.`,
				durationMs: 0,
			} satisfies ExecToolResult;
		}
		return null;
	}
	return {
		type: "tool_result",
		tool: "exec" as const,
		call,
		exitCode: 1,
		stdout: "",
		stderr: `Command blocked: '${blockedCmd}' is in the BLOCKED_COMMANDS list and requires manual review before execution.`,
		durationMs: 0,
	} satisfies ExecToolResult;
}
export async function* execToolStream(
	call: ExecToolCall,
	confirmFn: ((question: string) => Promise<string>) | undefined,
	toolsConfig: {
		workspace: string;
		tempDir: string;
		blockedCommands: string[];
		defaultExecTimeout: number;
	},
): AsyncGenerator<ToolStreamEvent> {
	const runtime = call.args.runtime ?? DEFAULT_RUNTIME;
	const workspace = toolsConfig.workspace;
	const cwd = call.args.cwd
		? isAbsolute(call.args.cwd)
			? call.args.cwd
			: resolve(workspace, call.args.cwd)
		: workspace;
	const timeoutMs =
		(call.args.timeout ?? toolsConfig.defaultExecTimeout) * 1000;
	const start = Date.now();

	// Security check — scan script content for blocked commands
	const blockedCmd = findBlockedCommand(
		call.args.script,
		toolsConfig.blockedCommands,
	);
	if (blockedCmd !== null) {
		const blocked = await handleBlockedCommand(
			call,
			cwd,
			blockedCmd,
			confirmFn,
		);
		if (blocked) {
			yield blocked;
			return;
		}
	}

	// Write script to temp file, execute with specified runtime
	const ext = RUNTIME_EXT[runtime] ?? "";
	const tempDir = resolve(toolsConfig.tempDir);
	if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
	const tmpFile = join(
		tempDir,
		`_n0n_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`,
	);

	try {
		// cmd runtime: prefix with @ to suppress echo
		const scriptContent =
			runtime === "cmd" ? `@${call.args.script}\n` : call.args.script;
		await Bun.write(tmpFile, scriptContent);

		const spawnCmd = buildSpawnCmd(runtime, tmpFile);
		const proc = Bun.spawn(spawnCmd, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});

		const timer = setTimeout(() => {
			proc.kill();
		}, timeoutMs);

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const decoder = new TextDecoder();

		const pending: ToolOutputChunk[] = [];
		let streamsDone = 0;
		let notify: (() => void) | null = null;

		const pumpStream = async (
			stream: ReadableStream<Uint8Array>,
			bucket: string[],
		) => {
			const reader = stream.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value, { stream: true });
					bucket.push(text);
					pending.push({
						type: "tool_output_chunk",
						callId: call.id,
						tool: "exec",
						chunk: text,
					});
					notify?.();
				}
			} finally {
				reader.releaseLock();
				streamsDone++;
				notify?.();
			}
		};

		if (!proc.stdout || !proc.stderr) {
			throw new Error("Failed to capture process streams (stdout/stderr)");
		}
		pumpStream(proc.stdout, stdoutChunks);
		pumpStream(proc.stderr, stderrChunks);

		while (streamsDone < 2 || pending.length > 0) {
			if (pending.length === 0) {
				await new Promise<void>((r) => {
					notify = r;
				});
				notify = null;
			}
			while (pending.length > 0) {
				const chunk = pending.shift();
				if (chunk) yield chunk;
			}
		}

		const exitCode = await proc.exited;
		clearTimeout(timer);

		const durationMs = Date.now() - start;
		const stdout = stdoutChunks.join("");
		const stderr = stderrChunks.join("");

		const maxLen = 30_000;
		const truncate = (s: string) =>
			s.length > maxLen
				? `${s.slice(0, maxLen)}\n... [truncated, ${s.length} chars total]`
				: s;

		const hasOutput = stdout.trim() || stderr.trim();
		const hint =
			!hasOutput && exitCode === 0
				? "(no output — script may not have top-level executable code, or async operations may not have been awaited.)"
				: "";

		yield {
			type: "tool_result",
			tool: "exec" as const,
			call,
			exitCode,
			stdout: hint || truncate(stdout),
			stderr: truncate(stderr),
			durationMs,
		} satisfies ExecToolResult;
	} catch (err) {
		yield {
			type: "tool_result",
			tool: "exec" as const,
			call,
			exitCode: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - start,
		} satisfies ExecToolResult;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// ignore cleanup errors
		}
	}
}
