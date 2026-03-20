#!/usr/bin/env bun
/**
 * n0n CLI 入口
 *
 * 作为全局 CLI 工具 `n0n` 的入口点。
 * 运行目录即为默认工作目录（workspace），无需额外指定。
 *
 * 用法：
 *   n0n                    — 以当前目录为 workspace 启动
 *   n0n --workspace <dir>  — 指定 workspace 目录
 *   n0n <dir>              — 拖拽目录 / 裸路径参数
 *   n0n --version / -v     — 显示版本号
 *   n0n --help / -h        — 显示帮助信息
 *   n0n --resume <file>    — 从对话日志文件恢复对话
 *   n0n --save-every-loop  — 每轮 agentLoop 结束后自动保存对话
 */

import { version } from "../package.json";

const args = process.argv.slice(2);

// ── --version / -v ──
if (args.includes("--version") || args.includes("-v")) {
	console.log(`n0n v${version}`);
	process.exit(0);
}

// ── --help / -h ──
if (args.includes("--help") || args.includes("-h")) {
	console.log(`n0n v${version} — Code Agent

用法:
  n0n                     以当前目录为 workspace 启动
  n0n <dir>               指定 workspace 目录（支持拖拽）
  n0n --workspace <dir>   显式指定 workspace 目录
  n0n --resume <file>     从对话日志文件恢复对话
  n0n --save-every-loop   每轮自动保存对话到 n0n-conversation-latest.json
  n0n -v, --version       显示版本号
  n0n -h, --help          显示帮助信息

环境变量:
  N0N_CODE_WORKSPACE      默认 workspace 路径（优先级低于命令行参数）
`);
	process.exit(0);
}

// ── 解析 --resume 和 --save-every-loop ──
let resumeFile: string | undefined;
let saveEveryLoop = false;

const resumeIdx = args.indexOf("--resume");
if (resumeIdx !== -1) {
	resumeFile = args[resumeIdx + 1];
	if (!resumeFile) {
		console.error("错误：--resume 需要指定文件路径");
		process.exit(1);
	}
	// 从 args 中移除 --resume 和文件路径，避免影响后续解析
	args.splice(resumeIdx, 2);
}

if (args.includes("--save-every-loop")) {
	saveEveryLoop = true;
	args.splice(args.indexOf("--save-every-loop"), 1);
}

// 将解析结果挂载到全局，供 index.ts 读取
(globalThis as Record<string, unknown>).__n0n_cli_opts = {
	resumeFile,
	saveEveryLoop,
	filteredArgs: [...args],
};

// ── 启动主流程 ──
// 动态 import 以确保 --version/--help 快速响应
await import("./index.ts");
