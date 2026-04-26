/**
 * Editor Evaluation Runner
 *
 * 读取 .secret.json（API 凭据）和 editor-llm-config.json（模型配置），
 * 对每个配置标签运行 6 个测试场景各 3 次，记录完整循环日志，
 * 输出结构化评估报告。
 *
 * 运行方式：
 *   cd /d e:\_Project\n0n && bun run packages/tools/src/edit/__tests__/editor-eval.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AnthropicProviderConfig,
	OpenAICompatibleProviderConfig,
	OpenAIProviderConfig,
	ProviderConfig,
} from "@n0n/llm";
import { createLLMClient, createResponsesClient } from "@n0n/llm";
import type { StreamEvent, TokenUsage } from "@n0n/types";
import type { EditBackend, EditBackendResult } from "../backend.ts";
import { FreeformPatchBackend } from "../freeform-patch/index.ts";
import { StrReplaceBackend } from "../str-replace/index.ts";
import type { TestScenario } from "./editor-test-dataset.ts";
import { TEST_SCENARIOS } from "./editor-test-dataset.ts";

// ── Types ──

interface SecretConfig {
	base_url: string;
	api_key: string;
}

interface ConfigPreset {
	label: string;
	config: {
		EDIT_BACKEND: "str-replace" | "freeform-patch";
		EDITOR_LLM_PROVIDER: string;
		EDITOR_LLM_BACKEND_PROVIDER?: string;
		EDITOR_LLM_MODEL: string;
		EDITOR_LLM_ENABLE_THINKING?: boolean;
	};
}

interface RoundRecord {
	round: number;
	events: string[];
	toolResults: string[];
	reasoning?: string;
	tokenUsage: TokenUsage | null;
}

interface RunRecord {
	presetLabel: string;
	scenarioId: string;
	runIndex: number;
	success: boolean;
	error: string | null;
	feedback: string | null;
	rounds: number;
	durationMs: number;
	contentChanged: boolean;
	roundsDetail: RoundRecord[];
	parsedScore: number | null;
	totalTokenUsage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
}

// ── 路径 ──

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SECRET_PATH = resolve(TESTS_DIR, ".secret.json");
const CONFIG_PATH = resolve(TESTS_DIR, "editor-llm-config.json");
const REPORT_DIR = resolve(TESTS_DIR, "eval-reports");

// ── 读取配置 ──

function loadSecrets(): SecretConfig {
	if (!existsSync(SECRET_PATH)) {
		throw new Error(`Secret file not found: ${SECRET_PATH}`);
	}
	return JSON.parse(readFileSync(SECRET_PATH, "utf-8"));
}

function loadConfigPresets(): ConfigPreset[] {
	if (!existsSync(CONFIG_PATH)) {
		throw new Error(`Config file not found: ${CONFIG_PATH}`);
	}
	return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

// ── 构建 ProviderConfig ──

function buildProviderConfig(
	preset: ConfigPreset,
	secrets: SecretConfig,
): ProviderConfig {
	const cfg = preset.config;
	const provider = cfg.EDITOR_LLM_PROVIDER || "openai-compatible";

	switch (provider) {
		case "openai":
			return {
				provider: "openai",
				apiKey: secrets.api_key,
				model: cfg.EDITOR_LLM_MODEL,
				...(secrets.base_url ? { baseUrl: secrets.base_url } : {}),
			} satisfies OpenAIProviderConfig;

		case "anthropic":
			return {
				provider: "anthropic",
				apiKey: secrets.api_key,
				model: cfg.EDITOR_LLM_MODEL,
				...(secrets.base_url ? { baseUrl: secrets.base_url } : {}),
				...(cfg.EDITOR_LLM_ENABLE_THINKING
					? { thinking: { budgetTokens: 1024 } }
					: {}),
			} satisfies AnthropicProviderConfig;

		case "openai-compatible":
			return {
				provider: "openai-compatible",
				apiKey: secrets.api_key,
				model: cfg.EDITOR_LLM_MODEL,
				baseUrl: secrets.base_url,
				...(cfg.EDITOR_LLM_BACKEND_PROVIDER
					? {
							backendProvider: cfg.EDITOR_LLM_BACKEND_PROVIDER as
								| "anthropic"
								| "google"
								| "openai",
						}
					: {}),
				...(cfg.EDITOR_LLM_ENABLE_THINKING ? { enableThinking: true } : {}),
			} satisfies OpenAICompatibleProviderConfig;

		default:
			throw new Error(`Unsupported provider: ${provider}`);
	}
}

// ── 创建后端 ──

function createBackend(
	preset: ConfigPreset,
	providerConfig: ProviderConfig,
): EditBackend {
	const backendType = preset.config.EDIT_BACKEND;

	if (backendType === "str-replace") {
		const client = createLLMClient({ providerConfig });
		return new StrReplaceBackend(client);
	}

	if (backendType === "freeform-patch") {
		const client = createResponsesClient({
			baseUrl: (providerConfig as OpenAICompatibleProviderConfig).baseUrl,
			apiKey: providerConfig.apiKey,
			model: providerConfig.model,
		});
		return new FreeformPatchBackend(client);
	}

	throw new Error(`Unknown backend type: ${backendType}`);
}

// ── 解析反馈分数 ──

function parseScore(feedback: string | null): number | null {
	if (!feedback) return null;
	const match = feedback.match(/\[(\d+)\/4\]/);
	return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

// ── 运行单个测试 ──

async function runSingleTest(
	backend: EditBackend,
	scenario: TestScenario,
	runIndex: number,
	presetLabel: string,
): Promise<RunRecord> {
	const roundsDetail: RoundRecord[] = [];
	let currentRound = -1;
	let reasoningAccum = "";

	const callbacks = {
		onEvent: (round: number, event: StreamEvent) => {
			if (round !== currentRound) {
				currentRound = round;
				roundsDetail.push({
					round,
					events: [],
					toolResults: [],
					tokenUsage: null,
				});
				reasoningAccum = "";
			}
			const rec = roundsDetail[roundsDetail.length - 1];
			if (!rec) return;

			switch (event.type) {
				case "thinking":
					reasoningAccum += event.text;
					rec.reasoning = reasoningAccum;
					break;
				case "content":
					rec.events.push(`content: ${event.text.slice(0, 100)}`);
					break;
				case "tool_call_delta":
					if (event.name) {
						rec.events.push(
							`tool: ${event.name} (${event.arguments?.length ?? 0} chars args)`,
						);
					}
					break;
				case "done":
					rec.events.push(`done: ${event.finishReason}`);
					rec.tokenUsage = event.usage ?? null;
					break;
				case "error":
					rec.events.push(`error: ${event.error}`);
					break;
			}
		},
		onToolResult: (round: number, summary: string) => {
			// Ensure the round record exists
			let rec = roundsDetail.find((r) => r.round === round);
			if (!rec) {
				rec = { round, events: [], toolResults: [], tokenUsage: null };
				roundsDetail.push(rec);
			}
			rec.toolResults.push(summary);
		},
	};

	const startTime = Date.now();
	const result: EditBackendResult = await backend.execute(
		scenario.source,
		scenario.intent,
		callbacks,
	);
	const durationMs = Date.now() - startTime;
	const totalTokenUsage = roundsDetail.reduce(
		(acc, rec) => {
			const usage = rec.tokenUsage;
			if (!usage) return acc;
			return {
				inputTokens: acc.inputTokens + (usage.inputTokens ?? 0),
				outputTokens: acc.outputTokens + (usage.outputTokens ?? 0),
				totalTokens: acc.totalTokens + (usage.totalTokens ?? 0),
				cacheReadTokens: acc.cacheReadTokens + (usage.cacheReadTokens ?? 0),
				cacheWriteTokens: acc.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
			};
		},
		{
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	);

	const contentChanged = result.content !== scenario.source;
	const parsedScore = parseScore(result.feedback);

	return {
		presetLabel,
		scenarioId: scenario.id,
		runIndex,
		success: !result.error && contentChanged,
		error: result.error,
		feedback: result.feedback,
		rounds: result.rounds,
		durationMs,
		contentChanged,
		roundsDetail,
		parsedScore,
		totalTokenUsage,
	};
}

// ── 评估是否符合预期 ──

function evaluateExpectation(run: RunRecord, scenario: TestScenario): string[] {
	const issues: string[] = [];

	// 评估成功/失败
	if (scenario.expectedSuccess && !run.success) {
		issues.push(
			`预期成功但失败: error="${run.error ?? "无 error, 但 content 未变化"}"`,
		);
	}
	if (!scenario.expectedSuccess && run.success) {
		issues.push(`预期拒绝但编辑成功(不应成功)`);
	}

	// 评估分数
	if (run.parsedScore !== null) {
		const minOk =
			scenario.expectedScoreMin !== undefined
				? run.parsedScore >= scenario.expectedScoreMin
				: true;
		const maxOk =
			scenario.expectedScoreMax !== undefined
				? run.parsedScore <= scenario.expectedScoreMax
				: true;
		if (!minOk) {
			issues.push(
				`分数 ${run.parsedScore} 低于预期最小值 ${scenario.expectedScoreMin}`,
			);
		}
		if (!maxOk) {
			issues.push(
				`分数 ${run.parsedScore} 高于预期最大值 ${scenario.expectedScoreMax}`,
			);
		}
	}

	// 评估反馈模式
	if (scenario.expectedFeedbackPattern && run.feedback) {
		if (!scenario.expectedFeedbackPattern.test(run.feedback)) {
			issues.push(
				`反馈未包含预期模式 /${scenario.expectedFeedbackPattern.source}/`,
			);
		}
	}

	return issues;
}

// ── 报告生成 ──

function generateMarkdownReport(
	allRuns: RunRecord[],
	scenarios: TestScenario[],
): string {
	const lines: string[] = [];
	const now = new Date().toISOString();

	lines.push(`# Editor 后端评估报告`);
	lines.push(`生成时间: ${now}\n`);
	lines.push(`## 总览\n`);

	// 按 preset 分组
	const presetLabels = [...new Set(allRuns.map((r) => r.presetLabel))];
	const scenarioIds = [...new Set(allRuns.map((r) => r.scenarioId))];
	const scenarioMap = new Map(scenarios.map((s) => [s.id, s]));

	// 汇总表
	lines.push("| Preset | 场景 | 成功/3 | 平均分 | 平均轮次 | 平均耗时(ms) |");
	lines.push("|--------|------|--------|--------|---------|-------------|");

	for (const preset of presetLabels) {
		const pRuns = allRuns.filter((r) => r.presetLabel === preset);
		for (const sid of scenarioIds) {
			const sRuns = pRuns.filter((r) => r.scenarioId === sid);
			if (sRuns.length === 0) continue;
			const successCount = sRuns.filter((r) => r.success).length;
			const avgScore =
				sRuns.length > 0
					? (
							sRuns.reduce((a, r) => a + (r.parsedScore ?? 0), 0) / sRuns.length
						).toFixed(1)
					: "N/A";
			const avgRounds =
				sRuns.length > 0
					? (sRuns.reduce((a, r) => a + r.rounds, 0) / sRuns.length).toFixed(1)
					: "N/A";
			const avgDuration =
				sRuns.length > 0
					? Math.round(
							sRuns.reduce((a, r) => a + r.durationMs, 0) / sRuns.length,
						)
					: 0;
			const scenario = scenarioMap.get(sid);
			const emoji = scenario?.expectedSuccess ? "✅/❌" : "❌/✅";
			lines.push(
				`| ${preset} | ${sid} ${emoji} | ${successCount}/3 | ${avgScore} | ${avgRounds} | ${avgDuration} |`,
			);
		}
	}

	lines.push("");

	// 详细运行日志
	lines.push("## 详细运行日志\n");

	for (const preset of presetLabels) {
		lines.push(`### ${preset}\n`);

		for (const sid of scenarioIds) {
			const sRuns = allRuns.filter(
				(r) => r.presetLabel === preset && r.scenarioId === sid,
			);
			if (sRuns.length === 0) continue;

			const scenario = scenarioMap.get(sid);
			lines.push(`#### ${sid}: ${scenario?.name ?? "?"}\n`);
			lines.push(`- 分类: ${scenario?.category ?? "?"}`);
			lines.push(
				`- 预期: ${scenario?.expectedSuccess ? "✅ 应成功" : "❌ 应拒绝"}`,
			);
			lines.push(`- Intent: \`${scenario?.intent ?? "?"}\`\n`);

			for (const run of sRuns) {
				const statusEmoji = run.success ? "✅" : "❌";
				const scoreStr =
					run.parsedScore !== null ? `[${run.parsedScore}/4]` : "[N/A]";
				lines.push(
					`**Run #${run.runIndex + 1}** ${statusEmoji} ${scoreStr} (${run.rounds} rounds, ${run.durationMs}ms)`,
				);

				if (run.error) {
					lines.push(`- Error: \`${run.error}\``);
				}
				if (run.feedback) {
					const escaped = run.feedback.replace(/\n/g, "\n  > ");
					lines.push(`- Feedback: \n  > ${escaped}`);
				}
				lines.push(`- Content changed: ${run.contentChanged}`);

				// 预期评价
				const issues = scenario ? evaluateExpectation(run, scenario) : [];
				if (issues.length > 0) {
					lines.push(`- ⚠️ 预期偏差:`);
					for (const issue of issues) {
						lines.push(`  - ${issue}`);
					}
				}

				// 轮次详情（简化版）
				if (run.roundsDetail.length > 0) {
					lines.push(`- 轮次轨迹:`);
					for (const rd of run.roundsDetail) {
						const toolSummary = rd.toolResults.join(", ") || "—";
						lines.push(`  - Round ${rd.round + 1}: ${toolSummary}`);
					}
				}
				lines.push("");
			}
		}
	}

	// 预期偏差汇总
	const allIssues: {
		preset: string;
		sid: string;
		run: number;
		issues: string[];
	}[] = [];
	for (const run of allRuns) {
		const scenario = scenarioMap.get(run.scenarioId);
		if (!scenario) continue;
		const issues = evaluateExpectation(run, scenario);
		if (issues.length > 0) {
			allIssues.push({
				preset: run.presetLabel,
				sid: run.scenarioId,
				run: run.runIndex + 1,
				issues,
			});
		}
	}

	if (allIssues.length > 0) {
		lines.push("## 预期偏差汇总\n");
		for (const entry of allIssues) {
			lines.push(`- **${entry.preset} / ${entry.sid} / Run #${entry.run}**:`);
			for (const issue of entry.issues) {
				lines.push(`  - ${issue}`);
			}
		}
		lines.push("");
	}

	// Token 使用统计
	lines.push("## Token 使用统计\n");

	lines.push(
		"| Preset | 场景 | 平均 Input Tokens | 平均 Output Tokens | 平均 Total Tokens | 总计 Total |",
	);
	lines.push(
		"|--------|------|-------------------|--------------------|-------------------|------------|",
	);

	for (const preset of presetLabels) {
		const pRuns = allRuns.filter((r) => r.presetLabel === preset);
		for (const sid of scenarioIds) {
			const sRuns = pRuns.filter((r) => r.scenarioId === sid);
			if (sRuns.length === 0) continue;
			const avgInput = Math.round(
				sRuns.reduce((a, r) => a + r.totalTokenUsage.inputTokens, 0) /
					sRuns.length,
			);
			const avgOutput = Math.round(
				sRuns.reduce((a, r) => a + r.totalTokenUsage.outputTokens, 0) /
					sRuns.length,
			);
			const avgTotal = Math.round(
				sRuns.reduce((a, r) => a + r.totalTokenUsage.totalTokens, 0) /
					sRuns.length,
			);
			const sumTotal = sRuns.reduce(
				(a, r) => a + r.totalTokenUsage.totalTokens,
				0,
			);
			lines.push(
				`| ${preset} | ${sid} | ${avgInput.toLocaleString()} | ${avgOutput.toLocaleString()} | ${avgTotal.toLocaleString()} | ${sumTotal.toLocaleString()} |`,
			);
		}
	}

	// 总 cost 估算（按 GPT-4o-mini 费率粗略计算：input $0.15/M, output $0.60/M）
	lines.push("\n### 费用估算（仅供参考）\n");
	const totalInput = allRuns.reduce(
		(a, r) => a + r.totalTokenUsage.inputTokens,
		0,
	);
	const totalOutput = allRuns.reduce(
		(a, r) => a + r.totalTokenUsage.outputTokens,
		0,
	);
	// 按 GPT-4o-mini 价格估算
	const inputCost = (totalInput / 1_000_000) * 0.15;
	const outputCost = (totalOutput / 1_000_000) * 0.6;
	const totalCost = inputCost + outputCost;

	lines.push(`- 总 Input Tokens: ${totalInput.toLocaleString()}`);
	lines.push(`- 总 Output Tokens: ${totalOutput.toLocaleString()}`);
	lines.push(`- 总 Tokens: ${(totalInput + totalOutput).toLocaleString()}`);
	lines.push(`- 估算费用 (GPT-4o-mini 费率): $${totalCost.toFixed(4)}`);
	lines.push("");

	// 附录
	lines.push("## 附录\n");
	lines.push(`- 总测试运行次数: ${allRuns.length}`);
	lines.push(`- 配置标签数: ${presetLabels.length}`);
	lines.push(`- 场景数: ${scenarioIds.length}`);
	lines.push(`- 每场景运行次数: 3\n`);

	return lines.join("\n");
}

// ── 保存报告 ──

function saveReport(report: string, _presetLabels: string[]) {
	mkdirSync(REPORT_DIR, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const filename = `eval-report-${timestamp}.md`;
	const filepath = resolve(REPORT_DIR, filename);
	writeFileSync(filepath, report, "utf-8");

	// Also save a latest symlink copy
	const latestPath = resolve(REPORT_DIR, "latest-report.md");
	writeFileSync(latestPath, report, "utf-8");

	console.log(`\n📄 报告已保存: ${filepath}`);
	console.log(`📄 最新报告: ${latestPath}`);
}

// ── 主函数 ──

async function main() {
	console.log("=".repeat(60));
	console.log("Editor 后端评估运行器");
	console.log("=".repeat(60));

	// 加载配置
	const secrets = loadSecrets();
	const presets = loadConfigPresets();
	const scenarios = TEST_SCENARIOS;

	console.log(`\n📋 加载了 ${presets.length} 个配置标签`);
	for (const p of presets) {
		console.log(
			`   - ${p.label} (${p.config.EDIT_BACKEND}, ${p.config.EDITOR_LLM_MODEL})`,
		);
	}
	console.log(`📋 加载了 ${scenarios.length} 个测试场景`);
	for (const s of scenarios) {
		console.log(`   - [${s.category}] ${s.id}: ${s.name}`);
	}

	const allRuns: RunRecord[] = [];

	for (const preset of presets) {
		console.log(`\n${"-".repeat(50)}`);
		console.log(`🚀 运行配置: ${preset.label}`);
		console.log(`   后端: ${preset.config.EDIT_BACKEND}`);
		console.log(`   模型: ${preset.config.EDITOR_LLM_MODEL}`);
		console.log(`${"-".repeat(50)}`);

		// 创建后端
		const providerConfig = buildProviderConfig(preset, secrets);
		const backend = createBackend(preset, providerConfig);
		console.log(`   ✅ 后端已创建: ${backend.name}`);

		for (const scenario of scenarios) {
			console.log(`\n   📝 场景: ${scenario.id} — ${scenario.name}`);

			for (let runIdx = 0; runIdx < 3; runIdx++) {
				process.stdout.write(`      Run #${runIdx + 1}... `);

				const run = await runSingleTest(
					backend,
					scenario,
					runIdx,
					preset.label,
				);
				allRuns.push(run);

				const statusIcon = run.success ? "✅" : "❌";
				const scoreStr =
					run.parsedScore !== null ? `[${run.parsedScore}/4]` : "[N/A]";
				console.log(
					`${statusIcon} ${scoreStr} ${run.rounds} rounds, ${run.durationMs}ms`,
				);

				// 反馈摘要
				if (run.feedback) {
					const firstLine = run.feedback.split("\n")[0] ?? "";
					console.log(`         feedback: ${firstLine}`);
				}
				if (run.error) {
					console.log(`         error: ${run.error.slice(0, 120)}`);
				}
			}
		}
	}

	// 生成报告
	console.log(`\n${"=".repeat(60)}`);
	console.log("📊 生成评估报告...");
	const report = generateMarkdownReport(allRuns, scenarios);
	saveReport(report, [...new Set(allRuns.map((r) => r.presetLabel))]);
	console.log("✅ 评估完成!");
	console.log("=".repeat(60));
}

main().catch((err) => {
	console.error("❌ 评估失败:", err);
	process.exit(1);
});
