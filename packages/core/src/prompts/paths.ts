/**
 * Prompt 模板路径 — core 内部使用
 *
 * 各 app（cli/code/feishu）已各自维护专用 system prompt，
 * 此处仅保留 core 内部需要的 delegate prompt 路径。
 */

import { resolve } from "node:path";

/** delegateTask system prompt 路径 */
export const DELEGATE_PROMPT_PATH = resolve(import.meta.dir, "delegate.md");
