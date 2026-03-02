import type { ZodType } from "zod";
import type { LLMToolDefinition } from "../types/llm.ts";
import { EXEC_TOOL_DEFINITION } from "./exec.ts";
import { REMINDER_TOOL_DEFINITION } from "./reminder.ts";
import { makeSubmitToolDefinition, SUBMIT_TOOL_DEFINITION } from "./submit.ts";
import { WRITE_TOOL_DEFINITION } from "./write.ts";

/** 默认工具定义（无 schema 约束，向后兼容） */
export const TOOL_DEFINITIONS: LLMToolDefinition[] = [
	EXEC_TOOL_DEFINITION,
	WRITE_TOOL_DEFINITION,
	REMINDER_TOOL_DEFINITION,
	SUBMIT_TOOL_DEFINITION,
];

/**
 * 根据可选的 Zod schema 生成工具定义列表。
 * 有 schema 时，submit 工具的描述会注入 JSON Schema 约束；
 * 无 schema 时返回默认定义（等价于 TOOL_DEFINITIONS）。
 */
export function makeToolDefinitions(schema?: ZodType): LLMToolDefinition[] {
	return [
		EXEC_TOOL_DEFINITION,
		WRITE_TOOL_DEFINITION,
		REMINDER_TOOL_DEFINITION,
		makeSubmitToolDefinition(schema),
	];
}

export { ENV_INFO, EXEC_TOOL_DEFINITION, execToolStream } from "./exec.ts";
export type { PendingReminder } from "./reminder.ts";
export { REMINDER_TOOL_DEFINITION, reminderTool } from "./reminder.ts";
export {
	makeSubmitToolDefinition,
	SUBMIT_TOOL_DEFINITION,
	submitTool,
} from "./submit.ts";
export { WRITE_TOOL_DEFINITION, writeTool } from "./write.ts";
