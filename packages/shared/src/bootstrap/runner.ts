/**
 * runner — bootstrap 主流程
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
	EnvSpec,
	EnvVarDef,
	SetupRenderer,
} from "@n0n/types";
import { generateEnvTemplate } from "./template.ts";

/** 从 EnvSpec 提取所有变量（扁平化） */
function allVars(spec: EnvSpec): EnvVarDef[] {
	return spec.groups.flatMap((g) => g.vars);
}

/** 查找缺失的必填变量 */
function findMissing(spec: EnvSpec): EnvVarDef[] {
	return allVars(spec).filter(
		(v) => v.default === undefined && !process.env[v.key],
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

/** 测试 LLM API 连通性 */
async function testLLMConnection(
	baseUrl: string,
	apiKey: string,
	model: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const url = baseUrl.includes("/chat/completions")
			? baseUrl
			: `${baseUrl}/v1/chat/completions`;

		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 1,
			}),
			signal: AbortSignal.timeout(15_000),
		});

		if (res.ok || res.status === 400) {
			// 400 也算连通（可能是参数问题但网络和认证是通的）
			return { ok: true };
		}
		if (res.status === 401 || res.status === 403) {
			return { ok: false, error: `认证失败 (${res.status})，请检查 API Key` };
		}
		const text = await res.text().catch(() => "");
		return {
			ok: false,
			error: `API 返回 ${res.status}: ${text.slice(0, 200)}`,
		};
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError") {
			return { ok: false, error: "连接超时（15s），请检查网络或 API 地址" };
		}
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `连接失败: ${msg}` };
	}
}

/**
 * 执行 bootstrap 引导流程
 *
 * @param spec 应用环境配置规格
 * @param ui SetupRenderer 实现
 * @param envDir .env 文件所在目录（默认 process.cwd()）
 */
export async function bootstrap(
	spec: EnvSpec,
	ui: SetupRenderer,
	envDir?: string,
): Promise<BootstrapResult> {
	const skipped: string[] = [];
	const dir = envDir ?? process.cwd();
	const envPath = resolve(dir, ".env");

	ui.info(`正在检查 ${spec.appName} 运行环境…`);

	// ── Step 1: .env 文件 ──

	if (existsSync(envPath)) {
		loadEnvFile(envPath);
		ui.success(`.env 已加载 (${envPath})`);
	} else {
		ui.warn("未找到 .env 文件");
		const shouldCreate = await ui.confirm("是否创建 .env 配置文件？");
		if (shouldCreate) {
			await createEnvInteractive(spec, ui, envPath);
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
				// 追加到 .env 文件
				if (existsSync(envPath)) {
					appendFileSync(envPath, `\n${v.key}=${value}\n`, { mode: 0o600 });
				}
			}
		}

		// 再次检查
		missing = findMissing(spec);
		if (missing.length > 0) {
			ui.error(`仍缺少必填配置: ${missing.map((v) => v.key).join(", ")}`);
			return { ok: false, env: {}, skipped };
		}
	}

	ui.success("配置检查通过");

	// ── Step 3: LLM 连通性测试 ──

	const baseUrl = process.env.LLM_BASE_URL;
	const apiKey = process.env.LLM_API_KEY;
	const model = process.env.LLM_MODEL;

	if (baseUrl && apiKey && model) {
		ui.info("测试 LLM 连接…");
		const conn = await testLLMConnection(baseUrl, apiKey, model);

		if (conn.ok) {
			ui.success(`LLM 连接正常 (${model})`);
		} else {
			ui.error(`LLM 连接失败: ${conn.error}`);
			const action = await ui.select("如何处理？", [
				{ label: "打开配置文件手动编辑", value: "edit" },
				{ label: "忽略，继续运行", value: "skip" },
			]);
			if (action === "edit") {
				ui.info(`请编辑: ${envPath}`);
				// 尝试用系统默认编辑器打开
				try {
					const editor = process.env.EDITOR || "vi";
					Bun.spawnSync([editor, envPath], {
						stdio: ["inherit", "inherit", "inherit"],
					});
					// 重新加载
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
		for (const v of group.vars) {
			if (v.default !== undefined) continue; // 可选的跳过，用模板默认值
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
