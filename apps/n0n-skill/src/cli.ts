#!/usr/bin/env bun
/**
 * n0n-skill CLI 入口
 *
 * 命令：
 *   help    — 列出可用 skill（仅 activation=auto）
 *   read    — 读取指定 skill 完整内容
 *   init    — 将内置 skill 写入 ~/.n0n/builtin-skills/
 *   install — 安装远程 skill
 *   create  — 创建新 skill 脚手架
 */

import { helpCommand } from "./commands/help.ts";
import { readCommand } from "./commands/read.ts";
import { initCommand } from "./commands/init.ts";
import { installCommand } from "./commands/install.ts";
import { createCommand } from "./commands/create.ts";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
	switch (command) {
		case "help":
		case undefined:
			await helpCommand();
			break;
		case "read":
			await readCommand(args[1]);
			break;
		case "init":
			await initCommand();
			break;
		case "install":
			await installCommand(args[1]);
			break;
		case "create":
			await createCommand(args[1]);
			break;
		default:
			console.error(`未知命令: ${command}`);
			console.error("可用命令: help, read, init, install, create");
			process.exit(1);
	}
}

main().catch((err) => {
	console.error(err.message ?? err);
	process.exit(1);
});
