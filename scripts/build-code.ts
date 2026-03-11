/**
 * build-code.ts — 将 apps/code 编译为全平台独立可执行文件
 *
 * 使用 `bun build --compile` 交叉编译，产出 Windows / macOS / Linux 三平台二进制。
 * 产物输出到 dist/ 目录。
 *
 * 用法：
 *   bun run scripts/build-code.ts              # 仅当前平台
 *   bun run scripts/build-code.ts --all        # 全平台
 *   bun run scripts/build-code.ts --target linux-x64  # 指定目标
 */

import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ENTRY = "apps/code/src/index.ts";
const OUT_DIR = resolve("dist");
const BIN_NAME = "n0n-code";

/** bun build --compile 支持的交叉编译目标 */
const TARGETS = {
	"windows-x64": { suffix: ".exe", label: "Windows x64" },
	"linux-x64": { suffix: "", label: "Linux x64" },
	"linux-arm64": { suffix: "", label: "Linux arm64" },
	"darwin-x64": { suffix: "", label: "macOS x64 (Intel)" },
	"darwin-arm64": { suffix: "", label: "macOS arm64 (Apple Silicon)" },
} as const;

type TargetKey = keyof typeof TARGETS;

function parseArgs(): TargetKey[] {
	const args = process.argv.slice(2);

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

	// 默认：当前平台
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const current = `${os}-${arch}` as TargetKey;
	return [current];
}

async function buildTarget(target: TargetKey): Promise<boolean> {
	const info = TARGETS[target];
	const outFile = resolve(OUT_DIR, `${BIN_NAME}-${target}${info.suffix}`);

	console.log(`\n🔨 Building ${info.label} → ${outFile}`);

	const proc = Bun.spawn(
		[
			"bun",
			"build",
			ENTRY,
			"--compile",
			"--target",
			`bun-${target}`,
			"--outfile",
			outFile,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		console.error(`❌ Failed: ${info.label} (exit ${exitCode})`);
		return false;
	}
	console.log(`✅ ${info.label} done`);
	return true;
}

async function main() {
	if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

	const targets = parseArgs();
	console.log(`📦 Building ${BIN_NAME} for: ${targets.join(", ")}`);

	let failed = 0;
	for (const target of targets) {
		const ok = await buildTarget(target);
		if (!ok) failed++;
	}

	console.log(
		`\n${failed === 0 ? "🎉" : "⚠️"} Done. ${targets.length - failed}/${targets.length} succeeded.`,
	);
	if (failed > 0) process.exit(1);
}

main();
