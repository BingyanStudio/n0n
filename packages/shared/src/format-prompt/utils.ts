/**
 * format-prompt 模块内部共享工具
 *
 * TagAdapter 注入模式：所有 format-*.ts 子模块接收 TagAdapter 实例，
 * 通过 tags.wrapTag(name, content) 和 tags.adaptTags(text) 进行标签处理。
 */

export type { TagAdapter } from "@n0n/types";
export { pick } from "./seed.ts";
