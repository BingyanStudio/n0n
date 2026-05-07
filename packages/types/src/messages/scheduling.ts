/**
 * 工具调度相关类型
 *
 * CanStartFn 是调度器用的行为约束函数签名，不属于 DomainMessage 数据层。
 */

import type { ToolCallRecord } from "./tools/index.ts";

/**
 * 工具并行条件判断函数。
 * scheduler 在决定是否启动队首工具时调用。
 *
 * @param self 待启动的工具调用
 * @param active 当前正在执行的所有工具调用
 * @returns true 表示可以立即启动，false 表示需要等待
 */
export type CanStartFn = (
	self: ToolCallRecord,
	active: readonly ToolCallRecord[],
) => boolean;
