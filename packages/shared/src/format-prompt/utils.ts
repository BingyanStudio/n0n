/**
 * format-prompt 模块内部共享工具
 *
 * TagAdapter 注入模式：所有 format-*.ts 子模块接收 TagAdapter 实例，
 * 通过 tags.wrapTag(name, content) 和 tags.adaptTags(text) 进行标签处理。
 */

export type { TagAdapter } from "@n0n/types";
export { pick } from "./seed.ts";

/**
 * 工具结果的结构化格式化输出。
 * fact: 客观事实（始终保留在历史中）
 * hint: 系统提示（仅最新轮保留，历史轮次中剥离）
 */
export interface FormattedToolResult {
  fact: string;
  hint: string | null;
}
