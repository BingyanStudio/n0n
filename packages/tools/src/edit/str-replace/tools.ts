/**
 * str-replace 后端内部工具定义
 *
 * Editor LLM 使用这三个工具完成编辑循环：
 * - str_replace: 精确文本替换
 * - view_file: 查看当前文件内容
 * - submit: 提交编辑完成 + 反馈评分
 */

import type { ToolDefinition } from "@n0n/types";

export const EDITOR_TOOLS: ToolDefinition[] = [
	{
		name: "str_replace",
		description:
			"Replace an exact substring in the file. The old_string must match character-for-character (including whitespace). Use the minimal unique fragment needed to identify the location.",
		parameters: {
			type: "object",
			properties: {
				old_string: {
					type: "string",
					description: "Exact substring to find in the current file content",
				},
				new_string: {
					type: "string",
					description: "Replacement text. Use empty string for deletions.",
				},
				expected_matches: {
					type: "number",
					description:
						"Expected number of matches for old_string. Defaults to 1. If actual matches differ from this value, the replacement is rejected.",
				},
			},
			required: ["old_string", "new_string"],
			additionalProperties: false,
		},
	},
	{
		name: "view_file",
		description:
			"View the current file content after previous edits. Optionally specify a line range to avoid reading the entire file.",
		parameters: {
			type: "object",
			properties: {
				start_line: {
					type: "number",
					description:
						"Start line number (1-based, inclusive). Omit to start from the beginning.",
				},
				end_line: {
					type: "number",
					description:
						"End line number (1-based, inclusive). Omit to read to the end.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "submit",
		description:
			"Submit when edits are complete, OR immediately when the intent is ambiguous/vague/impossible to execute. You MUST always provide deduction-based scored feedback using the [score/4] format.",
		parameters: {
			type: "object",
			properties: {
				feedback: {
					type: "string",
					description:
						"Deduction-based feedback: '[score/4] Verdict. {deductions} Details: ...' — start at 4, subtract: −1 if intent uses line numbers, −1 if those lines are trivially describable by name, −1 ambiguous target, −1 missing change spec, −2 unexecutable, −1 multi-concern. Minimum 0.",
				},
			},
			required: ["feedback"],
			additionalProperties: false,
		},
	},
];
