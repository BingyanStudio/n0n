/**
 * freeform-patch 后端工具定义
 *
 * 三个工具配合完成编辑闭环：
 * - apply_patch (custom/freeform): 生成并应用 patch
 * - view_file (function): 验证修改后的文件内容
 * - submit (function): 提交反馈评分，驱动主模型 ICL
 */

export const PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF
`;

export const APPLY_PATCH_TOOL = {
	type: "custom" as const,
	name: "apply_patch",
	description:
		"Apply a patch to edit the file. This is a FREEFORM tool — output raw patch text, not JSON.",
	format: {
		type: "grammar",
		syntax: "lark",
		definition: PATCH_GRAMMAR,
	},
};

export const VIEW_FILE_TOOL = {
	type: "function" as const,
	name: "view_file",
	description:
		"View the current file content after applying patches. Use to verify your changes are correct before submitting.",
	parameters: {
		type: "object",
		properties: {
			start_line: {
				type: "number",
				description: "Start line (1-based, inclusive). Omit to start from beginning.",
			},
			end_line: {
				type: "number",
				description: "End line (1-based, inclusive). Omit to read to end.",
			},
		},
	},
};

export const SUBMIT_TOOL = {
	type: "function" as const,
	name: "submit",
	description:
		"Submit when edits are complete, OR immediately when the intent is ambiguous/vague/impossible. You MUST provide deduction-based scored feedback using the [score/4] format.",
	parameters: {
		type: "object",
		properties: {
			feedback: {
				type: "string",
				description:
					"Deduction-based feedback: '[score/4] Verdict. {deductions}' — start at 4, subtract: −1 line-number ref, −1 trivially describable, −1 ambiguous target, −1 missing change spec, −2 unexecutable, −1 multi-concern. Minimum 0. When score < 4, add Rewrite line.",
			},
		},
		required: ["feedback"],
	},
};

export const ALL_TOOLS = [APPLY_PATCH_TOOL, VIEW_FILE_TOOL, SUBMIT_TOOL];
