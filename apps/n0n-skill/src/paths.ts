/**
 * n0n-skill 路径管理
 *
 * 全局配置目录 ~/.n0n/ 下管理 skill 文件：
 * - builtin-skills/ — 内置 skill，由 init 写入
 * - skills/ — 用户自定义和安装的 skill
 */

import { resolve } from "node:path";
import { homedir } from "node:os";

const N0N_DIR = ".n0n";
const BUILTIN_DIR = "builtin-skills";
const USER_DIR = "skills";

export function getN0nDir(): string {
	return resolve(homedir(), N0N_DIR);
}

export function getBuiltinSkillsDir(): string {
	return resolve(getN0nDir(), BUILTIN_DIR);
}

export function getUserSkillsDir(): string {
	return resolve(getN0nDir(), USER_DIR);
}

/** 返回 skill 扫描目录列表（builtin 在前，user 在后，user 覆盖 builtin） */
export function getSkillDirs(): string[] {
	return [getBuiltinSkillsDir(), getUserSkillsDir()];
}
