/**
 * build-code.ts — 将 apps/code 打包为轻量发行产物
 *
 * 策略：使用 `bun build --target bun` 产出单个 JS bundle（~400KB），
 * 而非 `--compile` 嵌入完整 Bun 运行时（~58MB）。
 *
 * 目标机器需要安装 bun 运行时（因为 workflow 本身就依赖 bun + TS）。
 * 产物为单文件分发：
 *   dist/n0n-code          — Unix 单文件（shebang + JS bundle，可直接 ./n0n-code 执行）
 *   dist/n0n-code.cmd      — Windows 单文件（自解压 bat+JS 多语言脚本）
 *
 * 用法：
 *   bun run scripts/build-code.ts              # 默认 minify
 *   bun run scripts/build-code.ts --no-minify  # 不压缩（调试用）
 *   bun run scripts/build-code.ts --compile    # 旧模式：嵌入运行时（大体积）
 */

import { mkdirSync, existsSync, chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENTRY = "apps/code/src/index.ts";
const OUT_DIR = resolve("dist");
const BIN_NAME = "n0n-code";

// ── 参数解析 ──

const args = process.argv.slice(2);
const noMinify = args.includes("--no-minify");
const compileMode = args.includes("--compile");

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

if (compileMode) {
	await buildCompile();
} else {
	await buildBundle();
}

// ── Bundle 模式（推荐）──

async function buildBundle() {
	const tmpJs = resolve(OUT_DIR, `${BIN_NAME}.tmp.js`);

	console.log("📦 Building bundle (target: bun)…");

	const buildArgs = [
		"bun", "build", ENTRY,
		"--target", "bun",
		"--outfile", tmpJs,
	];
	if (!noMinify) buildArgs.push("--minify");

	const proc = Bun.spawn(buildArgs, { stdout: "inherit", stderr: "inherit" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		console.error("❌ Bundle failed");
		process.exit(1);
	}

	const jsContent = await Bun.file(tmpJs).text();

	// ── Unix 单文件：shebang + JS bundle ──
	const unixFile = resolve(OUT_DIR, BIN_NAME);
	writeFileSync(unixFile, `#!/usr/bin/env bun\n${jsContent}`);
	chmodSync(unixFile, 0o755);

	// ── Windows 单文件：bat+JS polyglot ──
	// 原理：.cmd 文件开头是 batch 命令，用 bun 执行自身（跳过 batch 部分）
	const winFile = resolve(OUT_DIR, `${BIN_NAME}.cmd`);
	const winContent = [
		`@echo off`,
		`bun "%~f0" %*`,
		`exit /b %errorlevel%`,
		``,
		jsContent,
	].join("\r\n");
	writeFileSync(winFile, winContent);

	// 清理临时文件
	await Bun.file(tmpJs).exists() && (await Bun.$`rm ${tmpJs}`);

	// 结果摘要
	const sizeKB = (Buffer.byteLength(jsContent) / 1024).toFixed(0);
	const unixSizeKB = ((await Bun.file(unixFile).size) / 1024).toFixed(0);
	console.log("");
	console.log("✅ Bundle done — 单文件分发");
	console.log(`   ${unixFile}      (${unixSizeKB} KB) — chmod +x, 直接运行`);
	console.log(`   ${winFile}  (Windows polyglot)`);
	console.log(`   JS payload: ${sizeKB} KB`);
	console.log("");
	console.log(`💡 运行: ./dist/${BIN_NAME}  或  bun dist/${BIN_NAME}`);
}

// ── Compile 模式（旧，仅供需要完全独立二进制时使用） ──

const TARGETS = {
	"windows-x64": { suffix: ".exe", label: "Windows x64" },
	"linux-x64": { suffix: "", label: "Linux x64" },
	"linux-arm64": { suffix: "", label: "Linux arm64" },
	"darwin-x64": { suffix: "", label: "macOS x64 (Intel)" },
	"darwin-arm64": { suffix: "", label: "macOS arm64 (Apple Silicon)" },
} as const;
type TargetKey = keyof typeof TARGETS;

async function buildCompile() {
	const targets = parseCompileTargets();
	console.log(
		`📦 Building ${BIN_NAME} (compile mode) for: ${targets.join(", ")}`,
	);
	console.log(
		"⚠️  注意: compile 模式会嵌入 Bun 运行时（~58MB/平台），仅在需要独立二进制时使用。",
	);

	let failed = 0;
	for (const target of targets) {
		const info = TARGETS[target];
		const outFile = resolve(OUT_DIR, `${BIN_NAME}-${target}${info.suffix}`);
		console.log(`\n🔨 Building ${info.label} → ${outFile}`);

		const proc = Bun.spawn(
			[
				"bun", "build", ENTRY,
				"--compile",
				"--target", `bun-${target}`,
				"--outfile", outFile,
			],
			{ stdout: "inherit", stderr: "inherit" },
		);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			console.error(`❌ Failed: ${info.label} (exit ${exitCode})`);
			failed++;
		} else {
			console.log(`✅ ${info.label} done`);
		}
	}

	console.log(
		`\n${failed === 0 ? "🎉" : "⚠️"} Done. ${targets.length - failed}/${targets.length} succeeded.`,
	);
	if (failed > 0) process.exit(1);
}

function parseCompileTargets(): TargetKey[] {
	if (args.includes("--all")) {
		return Object.keys(TARGETS) as TargetKey[];
	}
	const targetIdx = args.indexOf("--target");
	if (targetIdx >= 0) {
		const target = args[targetIdx + 1] as TargetKey;
		if (!target || !(target in TARGETS)) {
			console.error(`Invalid target: ${target}`);
			console.error(`Available: ${Object.keys(TARGETS).join(", ")}`);
			process.exit(1);
		}
		return [target];
	}
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return [`${os}-${arch}` as TargetKey];
}
