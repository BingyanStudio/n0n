/**
 * Lark grammar 定义 + freeform tool 定义
 *
 * 定义 apply_patch 工具的格式规范，通过 OpenAI Responses API 传递。
 * 模型根据 grammar 生成结构化的纯文本 patch。
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
	type: "custom",
	name: "apply_patch",
	description:
		"Apply a patch to edit the file. This is a FREEFORM tool — output raw patch text, not JSON.",
	format: {
		type: "grammar",
		syntax: "lark",
		definition: PATCH_GRAMMAR,
	},
};
