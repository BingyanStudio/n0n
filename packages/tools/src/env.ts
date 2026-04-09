/**
 * env.ts — 系统环境探测（纯数据层）
 *
 * 职责：探测当前系统的 OS 信息和可用 runtime，缓存结果。
 * 不负责提示词拼接 — 那是 exec.ts 的事。
 *
 * Runtime 按用途分组，同组内有优先级：
 * - TS/JS:  bun > node > deno
 * - Python: python > python3 > uv（作为 python 的 wrapper）
 * - Shell:  平台默认(cmd/sh) + 可选(bash, pwsh)
 */

// === Types ===

/** 单个 runtime 的探测结果 */
export interface RuntimeProbe {
	/** runtime 标识符，即 exec 工具的 runtime 参数值 */
	name: string;
	/** 用途分组 */
	group: "shell" | "js" | "python";
	/** 是否在 PATH 中可用 */
	available: boolean;
	/** 版本号（探测成功时） */
	version: string | null;
	/** 同组内优先级（数字越小越优先） */
	priority: number;
}

/** 完整的环境信息快照 */
export interface EnvSnapshot {
	os: "windows" | "macos" | "linux" | string;
	platform: string;
	defaultShell: string;
	runtimes: RuntimeProbe[];
}

// === Runtime 定义 ===

interface RuntimeDef {
	name: string;
	group: "shell" | "js" | "python";
	/** 检测命令 */
	cmd: string;
	/** 获取版本的参数 */
	versionArgs: string[];
	/** 从版本输出中提取版本号的正则 */
	versionPattern: RegExp;
	/** 同组优先级 */
	priority: number;
	/** 仅在指定平台探测（null = 所有平台） */
	platforms: ("win32" | "darwin" | "linux")[] | null;
	/** 版本解析失败时是否仍标记为可用（shell 类为 true，语言类为 false） */
	versionOptional?: boolean;
}

const IS_WINDOWS = process.platform === "win32";

// COMMENT: runtime 探测按用途分组而非简单列举，是因为模型需要知道
// "我能用什么来执行 TypeScript/Python/Shell"，而不是"系统上装了什么"。
// 分组内有优先级（bun > node > deno），所以 exec 工具的 description 会
// 推荐最优的 runtime，同时列出备选。
// 如果模型选择了不存在的 runtime，exec 会直接报错而非静默降级——
// 因为静默降级可能导致脚本在不兼容的 runtime 上执行，产生更难调试的错误。
const RUNTIME_DEFS: RuntimeDef[] = [
	// Shell runtimes — 使用可移植的探测方式，版本为可选信息
	{
		name: "cmd",
		group: "shell",
		cmd: "cmd",
		versionArgs: ["/c", "ver"],
		versionPattern: /(\d+\.\d+[\w.]*)/,
		priority: 1,
		platforms: ["win32"],
		versionOptional: true,
	},
	{
		name: "sh",
		group: "shell",
		cmd: "sh",
		versionArgs: ["-c", "exit 0"],
		versionPattern: /^$/,
		priority: 1,
		platforms: ["darwin", "linux"],
		versionOptional: true,
	},
	{
		name: "bash",
		group: "shell",
		cmd: "bash",
		versionArgs: ["--version"],
		versionPattern: /(\d+\.\d+[\w.]*)/,
		priority: 2,
		platforms: null,
		versionOptional: true,
	},
	{
		name: "pwsh",
		group: "shell",
		cmd: "pwsh",
		versionArgs: [
			"-NoProfile",
			"-Command",
			"$PSVersionTable.PSVersion.ToString()",
		],
		versionPattern: /(\d+\.\d+[\w.]*)/,
		priority: 3,
		platforms: null,
		versionOptional: true,
	},
	// JS/TS runtimes — 版本必须匹配才标记为可用
	{
		name: "bun",
		group: "js",
		cmd: "bun",
		versionArgs: ["--version"],
		versionPattern: /(\d+\.\d+[\w.]*)/,
		priority: 1,
		platforms: null,
	},
	{
		name: "node",
		group: "js",
		cmd: "node",
		versionArgs: ["--version"],
		versionPattern: /v?(\d+\.\d+[\w.]*)/,
		priority: 2,
		platforms: null,
	},
	{
		name: "deno",
		group: "js",
		cmd: "deno",
		versionArgs: ["--version"],
		versionPattern: /deno\s+(\d+\.\d+[\w.]*)/,
		priority: 3,
		platforms: null,
	},
	// Python runtimes — 版本必须匹配才标记为可用（防止 Windows stub 误判）
	{
		name: "python",
		group: "python",
		cmd: "python",
		versionArgs: ["--version"],
		versionPattern: /Python\s+(\d+\.\d+[\w.]*)/,
		priority: 1,
		platforms: null,
	},
	{
		name: "python3",
		group: "python",
		cmd: "python3",
		versionArgs: ["--version"],
		versionPattern: /Python\s+(\d+\.\d+[\w.]*)/,
		priority: 2,
		platforms: null,
	},
	{
		name: "uv",
		group: "python",
		cmd: "uv",
		versionArgs: ["--version"],
		versionPattern: /uv\s+(\d+\.\d+[\w.]*)/,
		priority: 3,
		platforms: null,
	},
];

// === Detection ===

async function probeRuntime(def: RuntimeDef): Promise<RuntimeProbe> {
	const base: RuntimeProbe = {
		name: def.name,
		group: def.group,
		available: false,
		version: null,
		priority: def.priority,
	};

	// Skip if not applicable to current platform
	if (
		def.platforms &&
		!def.platforms.includes(process.platform as "win32" | "darwin" | "linux")
	) {
		return base;
	}

	try {
		const proc = Bun.spawn([def.cmd, ...def.versionArgs], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});

		const timer = setTimeout(() => proc.kill(), 5000);
		try {
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			// Windows python stub: exits 9009 or returns empty output
			if (exitCode !== 0) return base;

			const output = stdout + stderr;
			const match = output.match(def.versionPattern);
			const version = match?.[1] ?? null;

			// 语言类 runtime 必须成功解析版本号才标记为可用（防止 stub 误判）
			// shell 类 runtime 版本为可选信息（如 dash 不支持 --version）
			if (!version && !def.versionOptional) return base;

			return {
				...base,
				available: true,
				version,
			};
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return base;
	}
}

// === Cache & Public API ===

let cachedSnapshot: EnvSnapshot | null = null;

function buildOsName(): EnvSnapshot["os"] {
	switch (process.platform) {
		case "win32":
			return "windows";
		case "darwin":
			return "macos";
		case "linux":
			return "linux";
		default:
			return process.platform;
	}
}

/**
 * 探测系统环境，结果缓存（进程生命周期内只探测一次）。
 * 首次调用会并发探测所有 runtime，耗时约 1-2 秒。
 */
export async function detectEnv(): Promise<EnvSnapshot> {
	if (cachedSnapshot) return cachedSnapshot;

	const probes = await Promise.all(RUNTIME_DEFS.map(probeRuntime));

	cachedSnapshot = {
		os: buildOsName(),
		platform: process.platform,
		defaultShell: IS_WINDOWS ? "cmd" : "sh",
		runtimes: probes,
	};

	return cachedSnapshot;
}

/** 同步获取已缓存的环境快照（必须先调用过 detectEnv） */
export function getCachedEnv(): EnvSnapshot | null {
	return cachedSnapshot;
}

/** 获取某个分组中可用的 runtime，按优先级排序 */
export function getAvailableByGroup(
	snapshot: EnvSnapshot,
	group: "shell" | "js" | "python",
): RuntimeProbe[] {
	return snapshot.runtimes
		.filter((r) => r.group === group && r.available)
		.sort((a, b) => a.priority - b.priority);
}

/** 获取某个分组中优先级最高的可用 runtime */
export function getPreferredRuntime(
	snapshot: EnvSnapshot,
	group: "shell" | "js" | "python",
): RuntimeProbe | null {
	const available = getAvailableByGroup(snapshot, group);
	return available[0] ?? null;
}
