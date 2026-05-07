/**
 * @n0n/skill — 编程 API 入口
 *
 * CLI 入口为 cli.ts，此文件为 library 消费者提供编程接口。
 */

export { listSkills, readSkill, readSkills } from "./api.ts";
export { getSkillDirs, getBuiltinSkillsDir, getUserSkillsDir } from "./paths.ts";
export type { SkillContent, SkillMeta } from "./api.ts";
