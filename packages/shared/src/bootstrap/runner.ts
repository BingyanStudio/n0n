/**
 * runner — bootstrap 主流程
 *
 * 配置加载优先级（高→低）：
 * 1. 项目根 .env（由 Bun 运行时自动加载）
 * 2. 全局 ~/.n0n/.env（由 bootstrap 加载，不覆盖已存在值）
 * 3. 环境变量默认值（EnvSpec 中的 default 字段）
 *
 * 检测顺序：.env 文件 → 必填变量 → LLM 连通性
 * 缺什么补什么，全部通过才继续运行。
 */

import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
	BootstrapResult,
	ConfigEntry,
	ConfigGroup,
	ConfigSource,
	EnvSpec,
	EnvVarDef,
	SetupRenderer,
} from "@n0n/types";
import { generateEnvTemplate } from "./template.ts";

/**
 * LLM 连通性测试回调类型。
 *
 * 由上层（app 入口）注入，避免 shared 直接依赖 @n0n/llm
 * （打破 shared ↔ llm 循环依赖）。
 */
export type LLMConnectionTester = () => Promise<{
	ok: boolean;
	error?: string;
}>;

/** 从 EnvSpec 提取所有变量（扁平化） */
function allVars(spec: EnvSpec): EnvVarDef[] {
	return spec.groups.flatMap((g) => g.vars);
}

/** 查找缺失的必填变量 */
function findMissing(spec: EnvSpec): EnvVarDef[] {
	return allVars(spec).filter(
		(v) =>
			v.default === undefined &&
			!process.env[v.key] &&
			!(v.inheritFrom && process.env[v.inheritFrom]),
	);
}

/** 解析简单的 .env 文件（KEY=VALUE 格式，忽略注释和空行） */
function parseEnvFile(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx < 0) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const value = trimmed.slice(eqIdx + 1).trim();
		if (key) result[key] = value;
	}
	return result;
}

/** 加载 .env 文件到 process.env */
function loadEnvFile(
	envPath: string,
	options?: { override?: boolean },
): Record<string, string> {
	const text = readFileSync(envPath, "utf-8");
	const parsed = parseEnvFile(text);
	for (const [key, value] of Object.entries(parsed)) {
		if (options?.override || !process.env[key]) {
			process.env[key] = value;
		}
	}
	return parsed;
}

/** 掩码密钥：显示前 4 位 + 后 4 位 */
function maskSecret(value: string): string {
	if (value.length <= 8) return "****";
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * 检测项目根 .env（Bun 自动加载的那个）。
 *
 * Bun 在启动时自动加载 cwd 下的 .env 文件。
 * 这里不重新加载，只解析文件内容以获取 key-value 映射，用于来源追踪。
 */
function detectProjectEnv(): Record<string, string> {
	const projectEnvPath = resolve(process.cwd(), ".env");
	if (existsSync(projectEnvPath)) {
		return parseEnvFile(readFileSync(projectEnvPath, "utf-8"));
	}
	return {};
}

/**
 * 分析每个配置项的最终值和来源。
 */
function resolveConfigSources(
	spec: EnvSpec,
	projectEnv: Record<string, string>,
	globalEnv: Record<string, string>,
): ConfigEntry[] {
	const secretKeys = new Set(
		allVars(spec)
			.filter((v) => v.secret)
			.map((v) => v.key),
	);
	const result: ConfigEntry[] = [];

	for (const v of allVars(spec)) {
		const finalValue =
			process.env[v.key] ??
			(v.inheritFrom ? process.env[v.inheritFrom] : undefined) ??
			v.default;
		if (finalValue === undefined) continue;

		let source: ConfigSource;
		let overridden:
			| { value: string; source: ConfigSource }
			| undefined;

		const inProject = v.key in projectEnv;
		const inGlobal = v.key in globalEnv;

		if (inProject) {
			source = "project";
			if (inGlobal && projectEnv[v.key] !== globalEnv[v.key]) {
				overridden = { value: globalEnv[v.key] ?? "", source: "global" };
			}
		} else if (inGlobal) {
			source = "global";
		} else if (
			v.inheritFrom &&
			!process.env[v.key] &&
			process.env[v.inheritFrom]
		) {
			source = "inherit";
		} else if (v.default !== undefined && finalValue === v.default) {
			source = "default";
		} else {
			source = "env";
		}

		result.push({
			key: v.key,
			value: finalValue,
			source,
			secret: secretKeys.has(v.key),
			overridden,
		});
	}

	return result;
}

/** 格式化配置摘要日志 */
function formatConfigSummary(
	configs: ConfigEntry[],
	spec: EnvSpec,
): string {
	const secretKeys = new Set(
		allVars(spec)
			.filter((v) => v.secret)
			.map((v) => v.key),
	);

	const sourceLabel: Record<ConfigSource, string> = {
		project: "项目",
		global: "全局",
		env: "环境变量",
		default: "默认",
		inherit: "继承",
	};

	const lines: string[] = [];
	for (const c of configs) {
		const displayValue = secretKeys.has(c.key)
			? maskSecret(c.value)
			: c.value;
		const src = sourceLabel[c.source];
		let line = `  ${c.key} = ${displayValue}  (${src})`;
		if (c.overridden) {
			const overriddenDisplay = secretKeys.has(c.key)
				? maskSecret(c.overridden.value)
				: c.overridden.value;
			line += `  ← 覆盖了${sourceLabel[c.overridden.source]}值 ${overriddenDisplay}`;
		}
		lines.push(line);
	}
	return lines.join("\n");
}

/**
 * 执行 bootstrap 引导流程
 *
 * @param spec 应用环境配置规格
 * @param ui SetupRenderer 实现
 * @param envDir .env 文件所在目录（默认 process.cwd()）
 * @param testLLM LLM 连通性测试回调（可选，由上层注入）
 */
export async function bootstrap(
	spec: EnvSpec,
	ui: SetupRenderer,
	envDir?: string,
	testLLM?: LLMConnectionTester,
): Promise<BootstrapResult> {
	const skipped: string[] = [];
	const dir = envDir ?? process.cwd();
	const envPath = resolve(dir, ".env");

	ui.info(`正在检查 ${spec.appName} 运行环境…`);

	// ── Step 1: .env 文件加载 ──

	const projectEnv = detectProjectEnv();
	if (Object.keys(projectEnv).length > 0) {
		ui.info("检测到项目 .env (由 Bun 自动加载)");
	}

	let globalEnv: Record<string, string> = {};
	if (existsSync(envPath)) {
		globalEnv = loadEnvFile(envPath);
		ui.success(`.env 已加载 (${envPath})`);
	} else {
		ui.warn("未找到 .env 文件");
		const shouldCreate = await ui.confirm("是否创建 .env 配置文件？");
		if (shouldCreate) {
			await createEnvInteractive(spec, ui, envPath);
			globalEnv = existsSync(envPath)
				? parseEnvFile(readFileSync(envPath, "utf-8"))
				: {};
		} else {
			ui.info("跳过 .env 创建，将使用环境变量");
			skipped.push("env_file");
		}
	}

	// ── Step 2: 必填变量检查 ──

	let missing = findMissing(spec);
	if (missing.length > 0) {
		ui.warn(
			`缺少 ${missing.length} 个必填配置: ${missing.map((v) => v.key).join(", ")}`,
		);

		for (const v of missing) {
			const prompt = v.example
				? `请输入 ${v.key} (${v.desc}, 例如: ${v.example})`
				: `请输入 ${v.key} (${v.desc})`;
			const value = v.secret
				? await ui.secret(prompt)
				: await ui.input(prompt, undefined);

			if (value) {
				process.env[v.key] = value;
				if (existsSync(envPath)) {
					appendFileSync(envPath, `\n${v.key}=${value}\n`, { mode: 0o600 });
				}
			}
		}

		missing = findMissing(spec);
		if (missing.length > 0) {
			ui.error(`仍缺少必填配置: ${missing.map((v) => v.key).join(", ")}`);
			return { ok: false, env: {}, skipped };
		}
	}

	// ── Step 2.5: 配置摘要 ──

	const configEntries = resolveConfigSources(spec, projectEnv, globalEnv);
	const overrides = configEntries.filter((c) => c.overridden);

	const configGroups: ConfigGroup[] = spec.groups
		.map((g) => ({
			title: g.title,
			entries: configEntries.filter((e) =>
				g.vars.some((v) => v.key === e.key),
			),
		}))
		.filter((g) => g.entries.length > 0);

	if (ui.configTable) {
		ui.configTable(configGroups, overrides);
	} else {
		if (overrides.length > 0) {
			ui.warn(
				`${overrides.length} 项配置被项目 .env 覆盖：\n${overrides.map((c) => `  ${c.key}: ${c.overridden?.value} → ${c.value}`).join("\n")}`,
			);
		}
		ui.info(`当前配置:\n${formatConfigSummary(configEntries, spec)}`);
	}

	ui.success("配置检查通过");

	// ── Step 3: LLM 连通性测试 ──

	if (testLLM) {
		ui.info("测试 LLM 连接…");
		const conn = await testLLM();

		if (conn.ok) {
			const model = process.env.LLM_MODEL ?? "(unknown)";
			ui.success(`LLM 连接正常 (${model})`);
		} else {
			ui.error(`LLM 连接失败: ${conn.error}`);
			const action = await ui.select("如何处理？", [
				{ label: "打开配置文件手动编辑", value: "edit" },
				{ label: "忽略，继续运行", value: "skip" },
			]);
			if (action === "edit") {
				ui.info(`请编辑: ${envPath}`);
				try {
					const editor = process.env.EDITOR || "vi";
					Bun.spawnSync([editor, envPath], {
						stdio: ["inherit", "inherit", "inherit"],
					});
					loadEnvFile(envPath, { override: true });
					ui.info("配置已重新加载");
				} catch {
					ui.warn(`无法打开编辑器，请手动编辑 ${envPath} 后重新运行`);
					return { ok: false, env: {}, skipped };
				}
			} else {
				skipped.push("llm_connectivity");
				ui.warn("已跳过 LLM 连通性检查");
			}
		}
	}

	// ── 收集最终环境变量 ──

	const env: Record<string, string> = {};
	for (const v of allVars(spec)) {
		const val = process.env[v.key] ?? v.default;
		if (val !== undefined) env[v.key] = val;
	}

	ui.success(`${spec.appName} 初始化完成\n`);
	return { ok: true, env, skipped };
}

/** 交互式创建 .env 文件 */
async function createEnvInteractive(
	spec: EnvSpec,
	ui: SetupRenderer,
	envPath: string,
): Promise<void> {
	ui.info("开始配置向导…\n");
	const values: Record<string, string> = {};

	for (const group of spec.groups) {
		const requiredVars = group.vars.filter((v) => v.default === undefined);
		const allInheritable =
			requiredVars.length > 0 && requiredVars.every((v) => v.inheritFrom);

		if (allInheritable) {
			ui.info(`\n${group.title}:`);
			for (const v of requiredVars) {
				const parentKey = v.inheritFrom;
				if (!parentKey) continue;
				const parentVal = values[parentKey] ?? process.env[parentKey];
				if (!parentVal) {
					const prompt = v.example
						? `  ${v.desc} (${v.key}, 例如: ${v.example})`
						: `  ${v.desc} (${v.key})`;
					const value = v.secret
						? await ui.secret(prompt)
						: await ui.input(prompt, undefined);
					if (value) {
						values[v.key] = value;
						process.env[v.key] = value;
					}
					continue;
				}

				const displayVal = v.secret ? "****" : parentVal;
				const reuse = await ui.confirm(
					`  ${v.desc} — 使用与 ${parentKey} 相同的值？(${displayVal})`,
					true,
				);
				if (reuse) {
					process.env[v.key] = parentVal;
				} else {
					const prompt = v.example
						? `  ${v.desc} (${v.key}, 例如: ${v.example})`
						: `  ${v.desc} (${v.key})`;
					const value = v.secret
						? await ui.secret(prompt)
						: await ui.input(prompt, undefined);
					if (value) {
						values[v.key] = value;
						process.env[v.key] = value;
					}
				}
			}
			continue;
		}

		for (const v of group.vars) {
			if (v.default !== undefined) continue;
			const prompt = v.example
				? `  ${v.desc} (${v.key}, 例如: ${v.example})`
				: `  ${v.desc} (${v.key})`;
			const value = v.secret
				? await ui.secret(prompt)
				: await ui.input(prompt, undefined);
			if (value) {
				values[v.key] = value;
				process.env[v.key] = value;
			}
		}
	}

	const template = generateEnvTemplate(spec, values);
	writeFileSync(envPath, template, { mode: 0o600 });
	ui.success(`.env 已创建: ${envPath}\n`);
}
