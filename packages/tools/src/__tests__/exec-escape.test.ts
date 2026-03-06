/**
 * exec 工具转义处理测试
 *
 * 复现：模型通过 JSON tool_call 发送含转义字符的 bun -e 命令时，
 * 命令在 shell 中执行失败（Unterminated string literal）。
 */

import { describe, expect, test } from "bun:test";
import { ExecArgsSchema, execToolStream } from "../exec.ts";

/** 收集 exec 流式输出的最终结果 */
async function collectExecResult(command: string) {
	const args = ExecArgsSchema.parse({ command });
	let stdout = "";
	let stderr = "";
	let exitCode = -1;

	for await (const event of execToolStream("test-id", args)) {
		if (event.type === "tool_output_chunk") {
			// streaming chunk
		} else if (event.type === "tool_result" && event.tool === "exec") {
			stdout = event.stdout;
			stderr = event.stderr;
			exitCode = event.exitCode;
		}
	}
	return { stdout, stderr, exitCode };
}

describe("exec tool escape handling", () => {
	test("simple bun -e command works", async () => {
		const result = await collectExecResult('bun -e "console.log(42)"');
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("42");
	});

	test("bun -e with single quotes inside double quotes", async () => {
		const result = await collectExecResult(
			`bun -e "console.log('hello world')"`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello world");
	});

	test("bun -e with string split on newline (as model would generate via JSON)", async () => {
		// Model generates JSON: {"command": "bun -e \"const s = 'a\\nb'; console.log(s.split('\\n').length)\""}
		// After JSON.parse, command becomes: bun -e "const s = 'a\nb'; console.log(s.split('\n').length)"
		// The \n here is a literal newline character after JSON parse
		const commandFromJson = JSON.parse(
			'{"command": "bun -e \\"const s = \'a\\\\nb\'; console.log(s.split(\'\\\\n\').length)\\""}',
		).command;
		console.log("Command from JSON parse:", JSON.stringify(commandFromJson));

		const result = await collectExecResult(commandFromJson);
		console.log("stdout:", result.stdout);
		console.log("stderr:", result.stderr);
		console.log("exitCode:", result.exitCode);
		expect(result.exitCode).toBe(0);
	});

	test("bun -e with backslash-n in split (literal from model JSON)", async () => {
		// Simulating: model sends tool_call arguments as JSON string
		// The arguments field is: {"command": "bun -e \"console.log('abc\\ndef'.split('\\n'))\""}
		// After first JSON.parse (LLM response), \\n becomes \n (literal newline)
		const modelJsonArgs =
			'{"command": "bun -e \\"console.log(\'abc\\\\ndef\'.split(\'\\\\n\'))\\""}';
		const parsed = JSON.parse(modelJsonArgs);
		console.log("Parsed command repr:", JSON.stringify(parsed.command));

		const result = await collectExecResult(parsed.command);
		console.log("stdout:", result.stdout);
		console.log("stderr:", result.stderr);
		console.log("exitCode:", result.exitCode);
		// This should work — the question is whether it does
		expect(result.exitCode).toBe(0);
	});

	test("reproduce: exact failing command from user report", async () => {
		// The model generated this command (reconstructed from user's error output)
		// The key issue: after JSON parse, \n in the split becomes a literal newline
		const command = `bun -e "const files = ['create-weather-skill.ts']; for (const f of files) { try { const content = await Bun.file('workflows/tasks/' + f).text(); const firstLine = content.split('\\n')[0]; console.log(f + ':', firstLine); } catch(e) { console.log(f + ': error'); } }"`;
		console.log("Command repr:", JSON.stringify(command));

		const result = await collectExecResult(command);
		console.log("stdout:", result.stdout);
		console.log("stderr:", result.stderr);
		console.log("exitCode:", result.exitCode);
		expect(result.exitCode).toBe(0);
	});
});
