/**
 * format-prompt 模块内部共享工具
 *
 * 集中 re-export tag 相关函数，避免各子模块重复定义 wrapTag wrapper。
 */

export { adaptTagsFor as adaptTags, wrapTagFor as wrapTag } from "../tags.ts";
export { pick } from "./seed.ts";
