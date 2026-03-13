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
  n0n -v, --version       显示版本号
  n0n -h, --help          显示帮助信息

环境变量:
  N0N_CODE_WORKSPACE      默认 workspace 路径（优先级低于命令行参数）
`);
	process.exit(0);
}

// ── 启动主流程 ──
// 动态 import 以确保 --version/--help 快速响应
await import("./index.ts");
