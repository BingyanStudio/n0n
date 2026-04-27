/**
 * DeepSeek 模块 — 统一导出
 */

export { DeepSeekClient } from "./client.ts";

// directive 拦截与注入（可测试公共 API）
export {
	DIRECTIVE_TAGS,
	DIRECTIVE_PLACEHOLDER_RE,
	DeepSeekCollectingAdapter,
	injectDirectives,
} from "./directives.ts";
export type { CollectedDirective } from "./directives.ts";

// 消息格式转换（可测试公共 API）
export {
	toDeepSeekMessages,
	toDeepSeekTools,
	applyTaskToken,
} from "./formatter.ts";
export type {
	DeepSeekMessage,
	DeepSeekToolCall,
	DeepSeekToolDef,
} from "./formatter.ts";
