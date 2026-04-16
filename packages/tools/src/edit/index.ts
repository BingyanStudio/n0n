/**
 * edit 工具模块
 *
 * 拆分为子模块：
 * - edit.ts: 工具定义 + 流式执行入口
 * - backend.ts: EditBackend 抽象接口
 * - str-replace/: Editor LLM 多轮 str_replace 循环后端
 * - freeform-patch/: OpenAI Responses API + freeform patch 后端
 */

export type { EditBackend, EditBackendResult } from "./backend.ts";
export {
	EDIT_TOOL_DEFINITION,
	EditArgsSchema,
	editToolStream,
} from "./edit.ts";
export type { ResponsesClient } from "./freeform-patch/index.ts";
export { FreeformPatchBackend } from "./freeform-patch/index.ts";
export {
	applySingleOp,
	editorLoop,
	StrReplaceBackend,
} from "./str-replace/index.ts";
