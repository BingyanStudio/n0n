/**
 * progress 工具 — agent 唯一的结构化输出
 *
 * 每次调用 progress 时，agentLoop 终止并返回结果。
 * 外部调用方（repl.ts / headless.ts）拿到结果后自行决定是否重新启动循环。
 */

import type {
	ProgressToolCall,
	ProgressToolResult,
	ToolDefinition,
} from "@n0n/types";

// ── 配置类型 ──

export interface ProgressStatusConfig {
	/** status 枚举值 */
	value: string;
	/** 该 status 的含义说明（写入工具顶层 description） */
	statusDesc: string;
	/** 该 status 下 content 的格式说明（写入工具顶层 description） */
	contentDesc: string;
}

// ── 工具定义生成 ──

/**
 * 根据配置列表生成 progress 工具定义。
 *
 * 生成的工具：
 * - name: "progress"
 * - description: 包含所有 status 的含义和对应 content 格式（从配置拼接）
 * - parameters: { status: enum[...], content: string }
 */
export function makeProgressTool(config: ProgressStatusConfig[]): ToolDefinition {
	const statusDocs = config
		.map(c => `- ${c.value}: ${c.statusDesc}\n  content: ${c.contentDesc}`)
		.join("\n");

	const description = [
		"Report your current progress. This is the ONLY way to deliver content to the user.",
		"They cannot see your reasoning, tool calls, or intermediate results.",
		"",
		"Status types:",
		statusDocs,
		"",
		"Validation is enforced — non-conforming calls will be rejected.",
	].join("\n");

	const statusEnum = config.map(c => c.value);

	return {
		name: "progress",
		description,
		parameters: {
			type: "object",
			properties: {
				status: {
					type: "string",
					enum: statusEnum,
					description: "Current status",
				},
				content: {
					type: "string",
					description: "Content for this status",
				},
			},
			required: ["status", "content"],
			additionalProperties: false,
		},
	};
}

// ── 执行器 ──

export function progressTool(call: ProgressToolCall): ProgressToolResult {
	return {
		type: "tool_result",
		tool: "progress" as const,
		call,
		cleanedResult: call.args,
		userResponse: undefined,
	};
}
