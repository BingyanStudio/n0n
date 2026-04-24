/**
 * context-fewshot — Bootstrap 教学场景
 *
 * 三重作用：环境注入（真实 exec 结果）+ 行为教学（exec-as-thinking、并行调用、submit）+ 格式对齐（通过真实 toolkit 确保 tool_call 格式正确）。
 *
 * FEWSHOT_TEMPLATE 是模型看到的完整对话结构。三种 entry：
 * - DomainMessage — 静态消息，直接使用
 * - ExecSlot      — 需要真实执行，结果替换此位置
 * - DerivedSlot   — 从运行时上下文派生
 *
 * 3-turn 教学流程：
 * Turn 1: exec 推理（拆解任务）+ 5 个并行 exec 环境发现
 * Turn 2: exec 推理（规划步骤）+ write + edit + exec 执行任务
 * Turn 3: submit 提交结果
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

const BOOT_PLAN: ExecToolCall = {
	id: "boot_plan",
	tool: "exec",
	args: {
		runtime: "bun",
		script: `// system-reminder 里的任务有些驳杂，整理一下再执行
const raw = [
  { task: "Check OS, shell, git state",          tag: "env" },
  { task: "Read AGENTS.md",                      tag: "config" },
  { task: "Survey codebase structure",            tag: "scan" },
  { task: "Read and complete bootstrap-test.md",  tag: "task" },
  { task: "Discover CLI tools in PATH",           tag: "env" },
];
// 按认知顺序重排：先知道在哪 → 再知道项目要求 → 再看代码全貌 → 最后读具体任务
const sorted = [
  { pri: 0, label: "OS / shell / git",       reason: "先确定基础环境" },
  { pri: 1, label: "PATH 可用工具",           reason: "知道有什么能用" },
  { pri: 2, label: "AGENTS.md",              reason: "了解项目特定指令" },
  { pri: 3, label: "代码库结构",              reason: "建立项目全貌" },
  { pri: 4, label: "bootstrap-test.md 任务",  reason: "最后读具体要做的事" },
];
for (const s of sorted) console.log(\`\${s.pri}. \${s.label} — \${s.reason}\`);
// 全部是只读操作，互不依赖，可以一起发出
console.log("→ 5 项只读探测，并行执行");`,
	},
};

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

const PLAN_RESULT: DomainMessage = {
	type: "tool_result",
	tool: "exec" as const,
	call: BOOT_PLAN,
	status: "completed" as const,
	exitCode: 0,
	stdout: [
		"0. OS / shell / git — 先确定基础环境",
		"1. PATH 可用工具 — 知道有什么能用",
		"2. AGENTS.md — 了解项目特定指令",
		"3. 代码库结构 — 建立项目全貌",
		"4. bootstrap-test.md 任务 — 最后读具体要做的事",
		"→ 5 项只读探测，并行执行",
	].join("\n"),
	stderr: "",
	durationMs: 25,
};

const BOOT_THINK: ExecToolCall = {
	id: "boot_think",
	tool: "exec",
	args: {
		runtime: "bun",
		script: `// 整理 Turn 1 收集的信息，规划 bootstrap 任务
const steps = [
  { action: "write .temp/hello.ts",     tool: "write", deterministic: true },
  { action: "edit Status PENDING→DONE", tool: "edit",  deterministic: true },
  { action: "run hello.ts + cleanup",   tool: "exec",   deterministic: false },
];
// write/edit 结果已知（确定性工具），与 exec 同批发出
console.log("plan: " + steps.map(s => s.tool).join(", ") + " — 一次性发出");`,
	},
};

const THINK_RESULT: DomainMessage = {
	type: "tool_result",
	tool: "exec" as const,
	call: BOOT_THINK,
	status: "completed" as const,
	exitCode: 0,
	stdout: "plan: write, edit, exec — 一次性发出",
	stderr: "",
	durationMs: 30,
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

function buildTurn2Assistant(_ctx: RuntimeCtx): DomainMessage {
	return {
		type: "assistant_tool_call",
		content: null,
		reasoning: "让我整理一下。",
		reasoningSignature: null,
		toolCalls: [BOOT_THINK, TURN2_WRITE, TURN2_EDIT, TURN2_EXEC],
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
		reasoning: "确认完成，提交结果。",
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
			"【思维模式要求】",
			"面对复杂决策或分析时，用 exec 做思维实验——把心智模型写成具体的数据、逻辑或分步场景，然后检查结果。抽象推理会隐藏漏洞；具象化迫使你直面细节。exec 天然适合这件事：脚本可以结构化、计算和验证，// 注释可以内嵌推理且无副作用。当你发现自己在想“大概”“应该”“让我想想有哪些情况”时，这就是该具象化而非空想的信号。",
		].join("\n"),
	},

	// ── Turn 1: 5 个并行 exec 环境发现 ──
	{
		type: "assistant_tool_call",
		content: null,
		reasoning: "让我想想要做什么。",
		reasoningSignature: null,
		toolCalls: [BOOT_PLAN, BOOT_ENV, BOOT_TOOLS, BOOT_AGENTS, BOOT_CODE, BOOT_TASK],
	},

	PLAN_RESULT,
	{ _slot: "exec", call: BOOT_ENV },
	{ _slot: "exec", call: BOOT_TOOLS },
	{ _slot: "exec", call: BOOT_AGENTS },
	{ _slot: "exec", call: BOOT_CODE },
	{ _slot: "exec", call: BOOT_TASK },

	// ── Turn 2: exec 推理 + 执行 bootstrap 任务 ──
	{ _slot: "derived", build: buildTurn2Assistant },

	THINK_RESULT,
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
