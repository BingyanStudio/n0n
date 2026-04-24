/**
 * context-fewshot — Bootstrap 教学场景
 *
 * 设计方式：FEWSHOT_TEMPLATE 是模型看到的完整对话结构。
 * 三种 entry：
 * - DomainMessage — 静态消息，直接使用
 * - ExecSlot      — 需要真实执行，结果替换此位置
 * - DerivedSlot   — 从运行时上下文派生
 *
 * 3-turn 教学流程：
 * Turn 1: 环境发现（5 个并行 exec）
 * Turn 2: 执行任务（write + edit + exec），reasoning 包含 runtime 反思
 * Turn 3: 确认结果后 submit（教学：用户看不到 content，只有 submit 送达）
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Toolkit } from "@n0n/tools";
import type {
	DomainMessage,
	ExecToolCall,
	SubmitToolCall,
	SubmitToolResult,
	ToolCallRecord,
	ToolResult,
	ToolStreamEvent,
} from "@n0n/types";

// ── Slot 类型 ──

interface ExecSlot {
	_slot: "exec";
	call: ExecToolCall;
}

interface DerivedSlot {
	_slot: "derived";
	build: (ctx: RuntimeCtx) => DomainMessage;
}

type FewshotEntry = DomainMessage | ExecSlot | DerivedSlot;

interface RuntimeCtx {
	results: Map<string, ToolResult>;
	workspace: string;
	os: string;
	branch: string;
	codebaseSummary: string;
}

const IS_WINDOWS = process.platform === "win32";

// ── Turn 1 调用定义 ──

const BOOT_ENV: ExecToolCall = {
	id: "boot_1",
	tool: "exec",
	args: {
		script: IS_WINDOWS
			? "ver & git branch --show-current 2>nul & git status --short 2>nul"
			: 'echo "OS: $(uname -s)"; echo "Shell: $SHELL"; echo "Git branch: $(git branch --show-current 2>/dev/null || echo none)"; git status --short 2>/dev/null | head -20',
	},
};

const BOOT_AGENTS: ExecToolCall = {
	id: "boot_2",
	tool: "exec",
	args: {
		script: IS_WINDOWS
			? "type AGENTS.md 2>nul || echo (no AGENTS.md found)"
			: "cat AGENTS.md 2>/dev/null || echo '(no AGENTS.md found)'",
	},
};

const BOOT_CODE: ExecToolCall = {
	id: "boot_3",
	tool: "exec",
	args: {
		runtime: "bun",
		script: `import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
let files = 0, lines = 0;
const IGNORE = new Set(["node_modules",".git",".temp","dist",".turbo","bun.lock"]);
async function walk(dir, depth = 0) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (IGNORE.has(e.name)) continue;
    if (e.name.startsWith(".") && depth === 0) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await walk(full, depth + 1);
      if (sub.length) out.push("  ".repeat(depth)+"\u{1F4C1} "+e.name+"/", ...sub);
    } else if (e.name.match(/\\.(ts|js)$/) && !e.name.endsWith(".d.ts")) {
      const c = (await readFile(full,"utf8")).split("\\n").length;
      files++; lines += c;
      out.push("  ".repeat(depth)+e.name+\` (\${c} lines)\`);
    }
  }
  return out;
}
const tree = await walk(".");
const display = tree.length > 60 ? [...tree.slice(0, 60), \`... (\${tree.length - 60} more)\`] : tree;
console.log(display.join("\\n"));
console.log(\`\\nTotal: \${files} source files, \${lines} lines\`);`,
	},
};

const BOOT_TASK: ExecToolCall = {
	id: "boot_4",
	tool: "exec",
	args: {
		script: IS_WINDOWS
			? "type .temp\\bootstrap-test.md"
			: "cat .temp/bootstrap-test.md",
	},
};

const BOOT_TOOLS: ExecToolCall = {
	id: "boot_5",
	tool: "exec",
	args: {
		runtime: "bun",
		script: `import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME || '';
const isUser = d => (home && d.startsWith(home)) || d.startsWith('/opt/homebrew') || d === '/usr/local/bin';
const dirs = (process.env.PATH || '').split(':');
const seen = new Set();
for (const dir of dirs) {
  if (!dir || seen.has(dir) || !isUser(dir)) { seen.add(dir); continue; }
  seen.add(dir);
  try {
    const tools = readdirSync(dir).filter(n => { try { const s = statSync(join(dir, n)); return s.isFile() && (s.mode & 0o111); } catch { return false; } }).sort();
    if (tools.length) { const short = home && dir.startsWith(home) ? '~' + dir.slice(home.length) : dir; console.log(short + ': ' + tools.join(', ')); }
  } catch {}
}`,
	},
};

// ── Turn 2 静态调用 & 结果 ──

const TURN2_WRITE: ToolCallRecord = {
	id: "boot_w",
	tool: "write" as const,
	args: { path: ".temp/hello.ts", content: 'console.log("bootstrap ok");\n' },
};

const TURN2_EDIT: ToolCallRecord = {
	id: "boot_e",
	tool: "edit" as const,
	args: {
		path: ".temp/bootstrap-test.md",
		intent: "Change Status from PENDING to DONE",
	},
};

const TURN2_EXEC: ExecToolCall = {
	id: "boot_x",
	tool: "exec" as const,
	args: {
		script: IS_WINDOWS
			? "bun .temp/hello.ts && del .temp\\hello.ts .temp\\bootstrap-test.md"
			: "bun .temp/hello.ts && rm .temp/hello.ts .temp/bootstrap-test.md",
	},
};

const WRITE_RESULT: DomainMessage = {
	type: "tool_result",
	tool: "write" as const,
	call: TURN2_WRITE as import("@n0n/types").WriteToolCall,
	status: "completed" as const,
};

const EDIT_RESULT: DomainMessage = {
	type: "tool_result",
	tool: "edit" as const,
	call: TURN2_EDIT as import("@n0n/types").EditToolCall,
	diff: {
		chunks: [{
			startLine: 7, endLine: 7,
			lines: [{ line: 7, content: "Status: DONE", changed: true }],
		}],
		added: 1,
		removed: 1,
	},
	success: true,
	error: null,
	feedback: null,
	rounds: 1,
	durationMs: 800,
};

const EXEC_RESULT: DomainMessage = {
	type: "tool_result",
	tool: "exec" as const,
	call: TURN2_EXEC,
	status: "completed" as const,
	exitCode: 0,
	stdout: "bootstrap ok",
	stderr: "",
	durationMs: 150,
};

// ── 派生消息构建器 ──

function buildSubmitSummary(ctx: RuntimeCtx): string {
	return [
		"环境初始化完成。",
		`${ctx.os}，工作目录 ${ctx.workspace}，当前在 ${ctx.branch} 分支。`,
		`${ctx.codebaseSummary}。就绪，等待指令。`,
	].join("");
}

function buildTurn2Assistant(ctx: RuntimeCtx): DomainMessage {
	const runtimeLine = extractStdout(ctx.results.get("boot_5"))
		? "boot_3 使用 bun runtime 成功执行，确认 bun 可用。"
		: "";
	return {
		type: "assistant_tool_call",
		content: null,
		reasoning: [
			"环境扫描完成。",
			runtimeLine,
			"bootstrap-test.md 要求四件事：创建文件、修改状态、运行验证、清理临时文件。",
			"write 创建 .temp/hello.ts，edit 修改 Status——确定性工具，不需要等待结果。",
			"exec 运行 hello.ts 验证 bun 可用并清理。三个调用一次性发出。",
		].filter(Boolean).join(""),
		reasoningSignature: null,
		toolCalls: [TURN2_WRITE, TURN2_EDIT, TURN2_EXEC],
	};
}

function buildTurn3Submit(ctx: RuntimeCtx): DomainMessage {
	const submitCall: SubmitToolCall = {
		id: "boot_s",
		tool: "submit" as const,
		args: {
			type: "completed",
			summary: buildSubmitSummary(ctx),
			next_step: "等待指令。如有需要可随时查看上述环境信息。",
		},
	};
	return {
		type: "assistant_tool_call",
		content: null,
		reasoning: "write、edit、exec 全部成功，bootstrap ok 确认环境正常。用户无法看到文本消息，通过 submit 提交结果。",
		reasoningSignature: null,
		toolCalls: [submitCall],
	};
}

function buildSubmitResult(ctx: RuntimeCtx): DomainMessage {
	const submitCall: SubmitToolCall = {
		id: "boot_s",
		tool: "submit" as const,
		args: {
			type: "completed",
			summary: buildSubmitSummary(ctx),
			next_step: "等待指令。如有需要可随时查看上述环境信息。",
		},
	};
	return {
		type: "tool_result",
		tool: "submit" as const,
		call: submitCall,
		cleanedResult: submitCall.args,
		userResponse: undefined,
	} satisfies SubmitToolResult as DomainMessage;
}

// ════════════════════════════════════════════════════════════════
// ██  FEWSHOT TEMPLATE — 模型看到的完整对话结构
// ════════════════════════════════════════════════════════════════

const FEWSHOT_TEMPLATE: FewshotEntry[] = [
	// ── 用户请求初始化 ──
	{
		type: "generic_user_text",
		content: [
			"<system-reminder>",
			"Bootstrap: discover your environment before the user's first message.",
			"1. Check OS, shell, and git state",
			"2. Read AGENTS.md for project-specific instructions",
			"3. Survey the codebase structure",
			"4. Read and complete the bootstrap task in .temp/bootstrap-test.md",
			"5. Discover available CLI tools in PATH",
			"Submit when all steps are done.",
			"Note: The user cannot see your text responses — only submit results are delivered as push notifications.",
			"</system-reminder>",
			"",
			"帮我初始化工作环境。",
			"",
			"【思维模式要求】在你的思考过程中，请遵守以下规则：",
			"1. 分析任务可以拆解为哪些独立步骤，将没有依赖关系的工具调用在同一轮一次性全部发出，不要逐个等待",
			"2. 确定性工具（write、edit、reminder）总是成功——不需要等待结果确认，直接和其他调用并行发出",
			"3. 任务完成后必须通过 submit 工具提交结果，而不是用纯文本消息结束",
		].join("\n"),
	},

	// ── Turn 1: 5 个并行 exec 环境发现 ──
	{
		type: "assistant_tool_call",
		content: null,
		reasoning: "用户要求初始化环境。五个独立的探测命令：OS/shell/git 状态、项目指令、代码结构、bootstrap 任务、PATH 工具发现。全部并行发出。",
		reasoningSignature: null,
		toolCalls: [BOOT_ENV, BOOT_AGENTS, BOOT_CODE, BOOT_TASK, BOOT_TOOLS],
	},

	{ _slot: "exec", call: BOOT_ENV },
	{ _slot: "exec", call: BOOT_AGENTS },
	{ _slot: "exec", call: BOOT_CODE },
	{ _slot: "exec", call: BOOT_TASK },
	{ _slot: "exec", call: BOOT_TOOLS },

	// ── Turn 2: 执行 bootstrap 任务（write + edit + exec） ──
	// reasoning 包含对可用 runtime 的反思
	{ _slot: "derived", build: buildTurn2Assistant },

	WRITE_RESULT,
	EDIT_RESULT,
	EXEC_RESULT,

	// ── Turn 3: 确认结果 → submit ──
	// 教学：看到上一批执行结果后，通过 submit 提交（用户看不到 content）
	{ _slot: "derived", build: buildTurn3Submit },
	{ _slot: "derived", build: buildSubmitResult },
];

// ════════════════════════════════════════════════════════════════
// ██  渲染器
// ════════════════════════════════════════════════════════════════

function isSlot(entry: FewshotEntry): entry is ExecSlot | DerivedSlot {
	return "_slot" in entry;
}

async function runExec(
	toolkit: Toolkit,
	call: ExecToolCall,
): Promise<ToolResult> {
	const entry = toolkit.getEntry("exec");
	if (!entry?.stream)
		throw new Error("exec tool entry not found or not stream");
	const gen = (
		entry.execute as (
			tc: ToolCallRecord,
			r: never[],
		) => AsyncGenerator<ToolStreamEvent>
	)(call, []);
	let result: ToolResult | undefined;
	for await (const event of gen) {
		if (event.type === "tool_result") result = event;
	}
	if (!result)
		throw new Error(
			`exec tool did not yield a result for call ${call.id}`,
		);
	return result;
}

function extractStdout(result: ToolResult | undefined): string {
	if (!result || result.tool !== "exec") return "";
	if ("stdout" in result) return result.stdout;
	if ("stdoutSoFar" in result)
		return (result as { stdoutSoFar: string }).stdoutSoFar;
	return "";
}

function extractOs(stdout: string): string {
	return (
		stdout.match(/OS: (\S+)/)?.[1] ??
		(stdout.includes("Windows") ? "Windows" : "unknown")
	);
}

function extractBranch(stdout: string): string {
	const match = stdout.match(/Git branch: (\S+)/);
	if (match?.[1]) return match[1];
	if (!IS_WINDOWS) return "unknown";
	for (const line of stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)) {
		if (/^Microsoft Windows|^[MADRCU?!]{1,2}\s/.test(line)) continue;
		return line;
	}
	return "unknown";
}

const BOOTSTRAP_TASK = `# Bootstrap Task
1. Create .temp/hello.ts with: console.log("bootstrap ok")
2. Run it to verify bun works
3. Edit this file: change Status from PENDING to DONE
4. Clean up all temp files

Status: PENDING`;

async function renderFewshot(
	template: FewshotEntry[],
	toolkit: Toolkit,
	workspace: string,
	tempDir: string,
): Promise<DomainMessage[]> {
	const absTempDir = resolve(workspace, tempDir);
	if (!existsSync(absTempDir)) mkdirSync(absTempDir, { recursive: true });
	const taskFilePath = resolve(absTempDir, "bootstrap-test.md");
	writeFileSync(taskFilePath, BOOTSTRAP_TASK, "utf-8");

	const execSlots = template.filter(
		(e): e is ExecSlot => isSlot(e) && e._slot === "exec",
	);
	const execResults = await Promise.all(
		execSlots.map((s) => runExec(toolkit, s.call)),
	);
	const resultMap = new Map<string, ToolResult>();
	for (let i = 0; i < execSlots.length; i++) {
		resultMap.set(execSlots[i]!.call.id, execResults[i]!);
	}

	try {
		unlinkSync(taskFilePath);
	} catch {}

	const envStdout = extractStdout(resultMap.get("boot_1"));
	const codeStdout = extractStdout(resultMap.get("boot_3"));
	const ctx: RuntimeCtx = {
		results: resultMap,
		workspace,
		os: extractOs(envStdout),
		branch: extractBranch(envStdout),
		codebaseSummary:
			codeStdout.match(/Total: .+/)?.[0] ?? "项目结构已扫描",
	};

	return template.map((entry): DomainMessage => {
		if (!isSlot(entry)) return entry;
		if (entry._slot === "exec") return resultMap.get(entry.call.id)!;
		return entry.build(ctx);
	});
}

// ── 对外接口 ──

export async function buildContextFewshot(
	toolkit: Toolkit,
	workspace: string,
	tempDir: string,
): Promise<DomainMessage[]> {
	return renderFewshot(FEWSHOT_TEMPLATE, toolkit, workspace, tempDir);
}
