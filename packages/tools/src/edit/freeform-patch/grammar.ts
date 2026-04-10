/**
 * freeform-patch 后端工具定义（全部 freeform grammar）
 *
 * - apply_patch: 结构化 patch 格式
 * - view_file: 行范围（如 "10~20"、"-5"）或空（全部）
 * - submit: 反馈文本即输入内容
 */

const PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
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

const VIEW_FILE_GRAMMAR = `start: /[^\\n]*/
`;

const SUBMIT_GRAMMAR = `start: /[\\s\\S]+/
`;

export const APPLY_PATCH_TOOL = {
	type: "custom" as const,
	name: "apply_patch",
	description:
		"Apply a patch to edit the file. FREEFORM — output raw patch text.",
	format: { type: "grammar", syntax: "lark", definition: PATCH_GRAMMAR },
};

export const VIEW_FILE_TOOL = {
	type: "custom" as const,
	name: "view_file",
	description:
		'View the current file content. FREEFORM — output a line range like "10~20", or "-5" for last 5 lines, or empty for the entire file.',
	format: { type: "grammar", syntax: "lark", definition: VIEW_FILE_GRAMMAR },
};

export const SUBMIT_TOOL = {
	type: "custom" as const,
	name: "submit",
	description:
		"Submit when done (or immediately if intent is unexecutable). FREEFORM — output deduction-based feedback. Start at 4, subtract: −1 line-number ref, −1 trivially describable, −1 ambiguous target, −1 missing change spec, −2 unexecutable, −1 multi-concern. Format: '[score/4] Verdict. {tags}\\nRewrite: ...' — Rewrite is mandatory when score < 4.",
	format: { type: "grammar", syntax: "lark", definition: SUBMIT_GRAMMAR },
};

export const FIRST_ROUND_TOOLS = [APPLY_PATCH_TOOL, SUBMIT_TOOL];
export const ALL_TOOLS = [APPLY_PATCH_TOOL, VIEW_FILE_TOOL, SUBMIT_TOOL];
