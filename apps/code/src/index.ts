/**
 * Code Agent — 入口
 *
 * 代码编写场景的 agent，产出物为项目代码变更（而非 workflow）。
 * 复用 @n0n/core 的 agentLoop 引擎和 @n0n/cli-ui 的终端 UI。
 */

import { style, writeln } from "@n0n/cli-ui";
import { startCodeRepl } from "./repl.ts";

const args = process.argv.slice(2);
const initialInput = args.length > 0 ? args.join(" ") : undefined;

writeln(style.bold("n0n code") + style.gray(" — Code Agent"));
writeln(
	style.gray('描述你的编码任务，AI 将直接修改项目代码。输入 "exit" 退出。'),
);
writeln();

startCodeRepl(initialInput);
