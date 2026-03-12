/**
 * build-code.ts — 将 apps/code 打包为轻量发行产物
 *
 * 策略：使用 `bun build --target bun` 产出单个 JS bundle（~400KB），
 * 而非 `--compile` 嵌入完整 Bun 运行时（~58MB）。
 *
 * 目标机器需要安装 bun 运行时（因为 workflow 本身就依赖 bun + TS）。
 * 产物为单文件分发（sh/cmd + JS polyglot，自带 bun 检测）：
 *   dist/n0n-code          — Unix 单文件（sh/bun polyglot，可直接 ./n0n-code 执行）
 *   dist/n0n-code.cmd      — Windows 单文件（cmd/bun polyglot，双击或命令行运行）
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

// ── Compile 目标定义（需在 dispatch 前声明，避免 TDZ） ──

const TARGETS = {
	"windows-x64": { suffix: ".exe", label: "Windows x64" },
	"linux-x64": { suffix: "", label: "Linux x64" },
	"linux-arm64": { suffix: "", label: "Linux arm64" },
	"darwin-x64": { suffix: "", label: "macOS x64 (Intel)" },
	"darwin-arm64": { suffix: "", label: "macOS arm64 (Apple Silicon)" },
} as const;
type TargetKey = keyof typeof TARGETS;

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

	// ── Unix 单文件：sh/bun polyglot ──
	// 原理：shebang 让 shell 执行，`//` 行对 shell 是无害命令（路径不存在，stderr 丢弃），
	// 对 Bun 是行注释。shell 检测 bun 后 exec 替换为 bun 进程，Bun 跳过 shebang + // 行。
	const unixFile = resolve(OUT_DIR, BIN_NAME);
	const unixPreamble = [
		`#!/bin/sh`,
		`// 2>/dev/null; command -v bun >/dev/null 2>&1 || { echo "\\033[31m✗ 未找到 bun 运行时\\033[0m"; echo "  安装: curl -fsSL https://bun.sh/install | bash"; echo "  详情: https://bun.sh"; exit 1; }; exec bun "$0" "$@"`,
	].join("\n");
	writeFileSync(unixFile, `${unixPreamble}\n${jsContent}`);
	chmodSync(unixFile, 0o755);

	// ── Windows 单文件：cmd/bun polyglot ──
	// 原理：`//` 对 cmd 是无效命令（2>nul 吞错误），对 Bun 是行注释。
	// cmd 执行 `&` 链：echo off → 检测 bun → 调用 bun 执行自身 → exit。
	// Bun 跳过 `//` 注释行，直接执行后续 JS。
	const winFile = resolve(OUT_DIR, `${BIN_NAME}.cmd`);
	const winPreamble = `// 2>nul & @echo off & where bun >nul 2>nul || (echo ✗ 未找到 bun 运行时 & echo   安装: powershell -c "irm bun.sh/install.ps1 ^| iex" & echo   详情: https://bun.sh & pause & exit /b 1) & bun "%~f0" %* & exit /b %errorlevel%`;
	writeFileSync(winFile, `${winPreamble}\r\n${jsContent}`);

	// 清理临时文件
	await Bun.file(tmpJs).exists() && (await Bun.$`rm ${tmpJs}`);

	// 结果摘要
	const sizeKB = (Buffer.byteLength(jsContent) / 1024).toFixed(0);
	const unixSizeKB = ((await Bun.file(unixFile).size) / 1024).toFixed(0);
	console.log("");
	console.log("✅ Bundle done — 单文件分发（polyglot，自带 bun 检测）");
	console.log(`   ${unixFile}      (${unixSizeKB} KB) — chmod +x, 直接运行`);
	console.log(`   ${winFile}  (Windows polyglot)`);
	console.log(`   JS payload: ${sizeKB} KB`);
	console.log("");
	console.log(`💡 运行: ./dist/${BIN_NAME}  或  bun dist/${BIN_NAME}`);
}

// ── Compile 模式（旧，仅供需要完全独立二进制时使用） ──

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
