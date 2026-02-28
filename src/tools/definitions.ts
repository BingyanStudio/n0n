/**
 * 工具定义 — 提供给 LLM 的 JSON Schema 描述
 */

import type { LLMToolDefinition } from "../types/llm.ts";

const IS_WINDOWS = process.platform === "win32";

export const TOOL_DEFINITIONS: LLMToolDefinition[] = [
	{
		type: "function",
		function: {
			name: "exec",
			description: IS_WINDOWS
				? [
						"Execute a command via cmd.exe on Windows. Returns stdout, stderr, and exit code.",
						"Use Windows commands: `type` (not cat), `dir` (not ls), `findstr` (not grep). No `head`, `tail`, `wc`.",
						'Use `bun -e "..."` (double quotes only, no single quotes) for cross-platform JS one-liners.',
						"Known issues: `curl` may fail if a proxy is required — if curl returns exit code 6 or hangs, switch to `bun -e` with fetch().",
						"If a command fails 2-3 times, stop retrying and report the issue via submit.",
					].join("\n")
				: "Execute a shell command. Use for running code, reading files (cat/grep/head), system operations. Returns stdout, stderr, and exit code.",
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
					expectedMatches: {
						type: "number",
						description:
							"Expected number of matches (default: 1). Mismatch = error returned.",
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
			description: [
				"Set a memo/reminder for yourself (overwrites any previous reminder — only one active at a time).",
				"The content will be injected as a user message after N rounds.",
				"Usage: After breaking down the task into OKR (Objectives & Key Results), create a reminder summarizing:",
				"  1. The overall Objective",
				"  2. Key Results (checklist of what remains)",
				"  3. Current progress and next step",
				"When a reminder fires, you MUST set a new reminder (with updated progress) alongside your next tool call.",
			].join("\n"),
			parameters: {
				type: "object",
				properties: {
					content: {
						type: "string",
						description:
							"Reminder content: include OKR summary, progress status, and next steps",
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
				"Submit your final result. If you completed the task successfully, submit the result value. If you cannot complete the task and need more information, submit an error object like { ok: false, error: 'what went wrong and what you need' }. The caller will review and may provide additional info.",
			parameters: {
				type: "object",
				properties: {
					result: {
						description:
							"The result value. For success: the requested output. For error: { ok: false, error: string }.",
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
