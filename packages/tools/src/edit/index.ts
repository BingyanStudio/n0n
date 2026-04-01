/**
 * edit 工具模块
 *
 * 拆分为子模块：
 * - edit.ts: 工具定义 + 流式执行入口
 * - editor-loop.ts: Editor LLM 专用循环（str_replace/view_file/submit）
 * - edit.md: 工具描述文本
 * - editor-agent.md: Editor Agent 系统提示词
 */

export {
	EDIT_TOOL_DEFINITION,
	EditArgsSchema,
	editToolStream,
} from "./edit.ts";
export { applySingleOp, editorLoop } from "./editor-loop.ts";
