/**
 * bootstrap — 应用启动前的环境检测与交互式引导
 *
 * 检测顺序：.env 文件 → 必填变量 → LLM 连通性
 * 缺什么补什么，全部通过才继续。
 *
 * 设计原则：
 * - 检测逻辑在 shared 中（所有 app 共享）
 * - 配置规格由各 app 声明（EnvSpec）
 * - UI 交互通过 SetupRenderer 抽象（CLI/Feishu/Web 各自实现）
 */

export type { BootstrapResult, EnvGroup, EnvSpec, EnvVarDef } from "@n0n/types";
export { LLM_ENV_GROUP } from "./common-specs.ts";
export { bootstrap } from "./runner.ts";
export { generateEnvTemplate } from "./template.ts";
