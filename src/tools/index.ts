import type { LLMToolDefinition } from "../types/llm.ts";
import { EXEC_TOOL_DEFINITION } from "./exec.ts";
import { REMINDER_TOOL_DEFINITION } from "./reminder.ts";
import { SUBMIT_TOOL_DEFINITION } from "./submit.ts";
import { WRITE_TOOL_DEFINITION } from "./write.ts";

export const TOOL_DEFINITIONS: LLMToolDefinition[] = [
	EXEC_TOOL_DEFINITION,
	WRITE_TOOL_DEFINITION,
	REMINDER_TOOL_DEFINITION,
	SUBMIT_TOOL_DEFINITION,
];

export { ENV_INFO, EXEC_TOOL_DEFINITION, execToolStream } from "./exec.ts";
export type { PendingReminder } from "./reminder.ts";
export { REMINDER_TOOL_DEFINITION, reminderTool } from "./reminder.ts";
export { SUBMIT_TOOL_DEFINITION, submitTool } from "./submit.ts";
export { WRITE_TOOL_DEFINITION, writeTool } from "./write.ts";
