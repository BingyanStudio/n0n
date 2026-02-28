/**
 * DomainMessage ↔ LLM API 消息转换
 *
 * 领域消息是结构化数据记录，这里负责转换为 LLM provider 需要的格式。
 */

import type { DomainMessage, ToolResult } from "../types/domain.ts";
import type { LLMRequestMessage } from "../types/llm.ts";

/**
 * 将 ToolResult 转为人类可读的文本摘要
 */
function toolResultToContent(msg: ToolResult): string {
	switch (msg.tool) {
		case "exec": {
			const parts: string[] = [
				`$ ${msg.command}`,
				`[cwd: ${msg.cwd}] [exit: ${msg.exitCode}] [${msg.durationMs}ms]`,
			];
			if (msg.stdout) parts.push(msg.stdout);
			if (msg.stderr) parts.push(`STDERR:\n${msg.stderr}`);
			return parts.join("\n");
		}
		case "write": {
			if (msg.success) {
				return msg.searchPattern
					? `Written to ${msg.path}: replaced ${msg.replacedCount} occurrence(s)`
					: `Written to ${msg.path}: full file write`;
			}
			return `Write failed: ${msg.error}`;
		}
		case "reminder":
			return `Reminder set: will appear in ${msg.delay} rounds`;
		case "submit":
			return `Submitted: ${JSON.stringify(msg.result)}`;
	}
}

/**
 * DomainMessage[] → LLMRequestMessage[]
 */
export function toAPIMessages(messages: DomainMessage[]): LLMRequestMessage[] {
	const result: LLMRequestMessage[] = [];

	for (const msg of messages) {
		switch (msg.type) {
			case "system":
				result.push({ role: "system", content: msg.content });
				break;

			case "user_text":
				result.push({ role: "user", content: msg.content });
				break;

			case "user_image":
				// MVP: 将图片描述为文本占位
				result.push({
					role: "user",
					content: `[Image: ${msg.imagePath}] ${msg.text}`,
				});
				break;

			case "assistant_text":
				result.push({ role: "assistant", content: msg.content });
				break;

			case "assistant_tool_call":
				result.push({
					role: "assistant",
					content: msg.content,
					tool_calls: msg.toolCalls.map((tc) => ({
						id: tc.id,
						type: "function" as const,
						function: {
							name: tc.tool,
							arguments: JSON.stringify(tc.args),
						},
					})),
				});
				break;

			case "tool_result":
				result.push({
					role: "tool",
					tool_call_id: msg.callId,
					content: toolResultToContent(msg),
				});
				break;
		}
	}

	return result;
}
