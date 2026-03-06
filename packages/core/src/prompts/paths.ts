/**
 * Prompt 模板路径 — 供 cli 和 feishu 等 app 共享
 */

import { resolve } from "node:path";

/** 交互模式 system prompt 路径 */
export const INTERACTIVE_PROMPT_PATH = resolve(import.meta.dir, "interactive.md");

/** delegateTask system prompt 路径 */
export const DELEGATE_PROMPT_PATH = resolve(import.meta.dir, "delegate.md");
