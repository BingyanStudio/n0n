/**
 * 工具定义 — 提供给 LLM 的 JSON Schema 描述
 */

import type { LLMToolDefinition } from "../types/llm.ts";

export const TOOL_DEFINITIONS: LLMToolDefinition[] = [
	{
		type: "function",
		function: {
			name: "exec",
			description:
				"Execute a shell command. Use for running code, reading files (cat/grep/head), system operations. Returns stdout, stderr, and exit code.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "The shell command to execute",
					},
					cwd: {
						type: "string",
						description: "Working directory (default: project root)",
					},
					timeout: {
						type: "number",
						description:
							"Timeout in seconds (default: 120). Process continues in background if exceeded.",
					},
				},
				required: ["command"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "write",
			description:
				"Write or edit a file. If search is provided, replaces matching text. If search is empty/omitted, writes the entire file content. Use expectedReplaceTime to assert expected number of replacements.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "File path relative to project root",
					},
					search: {
						type: "string",
						description:
							"Text to search for. Empty or omitted = full file write.",
					},
					replace: {
						type: "string",
						description: "Replacement text",
					},
					expectedReplaceTime: {
						type: "number",
						description:
							"Expected number of replacements (default: 1). Mismatch = error returned.",
					},
				},
				required: ["path", "replace"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "reminder",
			description:
				"Set a reminder for yourself. The reminder content will be injected as a user message after N rounds. Use this to avoid forgetting important context in long tasks.",
			parameters: {
				type: "object",
				properties: {
					content: {
						type: "string",
						description: "Reminder content",
					},
					delay: {
						type: "number",
						description:
							"Number of rounds before reminder appears (default: 7)",
					},
				},
				required: ["content"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "submit",
			description:
				"Submit your final result. Use this when you have completed the task. If the caller specified a schema, your result must conform to it — otherwise it will be rejected and you'll need to retry.",
			parameters: {
				type: "object",
				properties: {
					result: {
						description:
							"The result value. Must match the caller's expected schema if one was provided.",
					},
					report: {
						type: "string",
						description:
							"Optional brief report of what was done and any notable findings.",
					},
				},
				required: ["result"],
				additionalProperties: false,
			},
		},
	},
];
