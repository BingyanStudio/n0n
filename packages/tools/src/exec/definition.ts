/**
 * exec 工具定义 — LLM 工具描述生成
 *
 * 根据环境快照动态生成 exec 工具的 ToolDefinition，
 * 描述中只包含当前系统可用的 runtime 及其示例。
 * 示例文本从 .md 文件导入，便于管理和编辑。
 */

import { wrapTagFor } from "@n0n/shared";
import type { ToolDefinition } from "@n0n/types";
import type { EnvSnapshot } from "../env.ts";
import { getAvailableByGroup } from "../env.ts";

// ── runtime 示例（从 .md 文件导入） ──

import bashExample from "./examples/bash.md" with { type: "text" };
import bunExample from "./examples/bun.md" with { type: "text" };
import cmdExample from "./examples/cmd.md" with { type: "text" };
import denoExample from "./examples/deno.md" with { type: "text" };
import nodeExample from "./examples/node.md" with { type: "text" };
import pwshExample from "./examples/pwsh.md" with { type: "text" };
import pythonExample from "./examples/python.md" with { type: "text" };
import python3Example from "./examples/python3.md" with { type: "text" };
import shExample from "./examples/sh.md" with { type: "text" };
import uvExample from "./examples/uv.md" with { type: "text" };

export { ExecArgsSchema } from "@n0n/types";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_RUNTIME = IS_WINDOWS ? "cmd" : "sh";

/** runtime name → 示例文本 */
const EXAMPLES: Record<string, string> = {
	cmd: cmdExample,
	sh: shExample,
	bash: bashExample,
	pwsh: pwshExample,
	bun: bunExample,
	node: nodeExample,
	deno: denoExample,
	python: pythonExample,
	python3: python3Example,
	uv: uvExample,
};

/** runtime 分组 */
const _EXAMPLES_BY_GROUP: Record<string, string[]> = {
	shell: ["cmd", "sh", "bash", "pwsh"],
	js: ["bun", "node", "deno"],
	python: ["python", "python3", "uv"],
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
	const body: string[] = [];
	for (const rt of available) {
		const ex = EXAMPLES[rt.name];
		if (ex) body.push(ex.trimEnd());
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
		"- **Prefer `write` and `edit` for file operations** — they are more efficient and easier to review than shell commands. Use `exec` for batch operations (bulk renames, bulk replacements) or when you need shell-specific functionality.",
		"- **Process output inside the script** — filter, summarize, format before printing. Avoid dumping large raw output.",
		"- **Output truncation** — stdout+stderr exceeding ~4 000 tokens is auto-truncated: only the **last ~1 000 tokens** are kept and the full output is saved to a file. To avoid losing important content, **assess first** (`wc -l`, `ls -la`) then read selectively (`head`, `grep`, `sed`) or split across parallel tool calls.",
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
