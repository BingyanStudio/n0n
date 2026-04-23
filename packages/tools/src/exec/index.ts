/**
 * exec 工具模块
 *
 * 拆分为三个子模块：
 * - definition: LLM 工具描述生成
 * - security: 命令黑名单检测与用户确认
 * - executor: 脚本执行（含 waitfor 等待超限转后台机制）
 */

export { ExecArgsSchema, makeExecToolDefinition } from "./definition.ts";
export { execToolStream } from "./executor.ts";
export {
	extractCommandNames,
	findBlockedCommand,
	handleBlockedCommand,
} from "./security.ts";
