/**
 * exec 后台同步行为验证测试
 *
 * 验证 backgrounded 进程的 bg 文件：
 * 1. 初始写入时包含正确的元数据（PID、status: running、started_at、last_updated）
 * 2. 定期更新 last_updated 时间戳（即使无新输出）
 * 3. 进程结束后写入终态元数据（exit_code、ended_at、duration）
 * 4. 新输出能被同步到 bg 文件
 */

import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { ExecToolCall, ExecToolResult } from "@n0n/types";
import { ExecArgsSchema, execToolStream } from "../exec/index.ts";

const pidsToCleanup: number[] = [];
const filesToCleanup: string[] = [];

afterAll(() => {
	for (const pid of pidsToCleanup) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const file of filesToCleanup) {
		try {
			unlinkSync(file);
		} catch {}
	}
});

/** 收集 exec 结果 */
async function collectResult(
	script: string,
	execWaitfor: number,
	runtime?: string,
): Promise<ExecToolResult> {
	const args = ExecArgsSchema.parse({ script, runtime, waitfor: execWaitfor });
	const call: ExecToolCall = { id: "bg-sync-test", tool: "exec", args };
	for await (const event of execToolStream(call, undefined, {
		workspace: process.cwd(),
		tempDir: ".temp",
		blockedCommands: [],
		defaultExecWaitfor: execWaitfor,
	})) {
		if (event.type === "tool_result" && event.tool === "exec") {
			return event;
		}
	}
	throw new Error("No tool_result yielded");
}

describe("exec bg 文件同步验证", () => {
	test("bg 文件初始写入包含 running 状态和元数据", async () => {
		const result = await collectResult(
			"await Bun.sleep(15000);",
			2,
			"bun",
		);

		expect(result.status).toBe("backgrounded");
		if (result.status !== "backgrounded") return;

		pidsToCleanup.push(result.pid);
		filesToCleanup.push(result.logFile);

		// bg 文件应该已存在
		expect(existsSync(result.logFile)).toBe(true);
		const content = readFileSync(result.logFile, "utf-8");

		// 验证元数据块存在
		expect(content).toContain("--- exec_bg_meta ---");
		expect(content).toContain(`pid: ${result.pid}`);
		expect(content).toContain("status: running");
		expect(content).toContain("started_at:");
		expect(content).toContain("last_updated:");
		expect(content).toContain("note:");
		// 验证输出段落
		expect(content).toContain("--- stdout ---");
		expect(content).toContain("--- stderr ---");
	}, 10000);

	test("bg 文件定期更新 last_updated（即使无新输出）", async () => {
		// 使用一个不产生输出、长时间运行的脚本
		const result = await collectResult(
			"await Bun.sleep(20000);",
			2,
			"bun",
		);

		expect(result.status).toBe("backgrounded");
		if (result.status !== "backgrounded") return;

		pidsToCleanup.push(result.pid);
		filesToCleanup.push(result.logFile);

		// 读取初始 last_updated
		const content1 = readFileSync(result.logFile, "utf-8");
		const match1 = content1.match(/last_updated: (.+)/);
		expect(match1).not.toBeNull();
		const time1 = new Date(match1![1]!).getTime();

		// 等待一个同步周期（3s）+ 缓冲
		await new Promise((r) => setTimeout(r, 4000));

		// 读取更新后的 last_updated
		const content2 = readFileSync(result.logFile, "utf-8");
		const match2 = content2.match(/last_updated: (.+)/);
		expect(match2).not.toBeNull();
		const time2 = new Date(match2![1]!).getTime();

		// last_updated 应该已更新（至少差 2 秒）
		expect(time2 - time1).toBeGreaterThanOrEqual(2000);
		// 仍然是 running 状态
		expect(content2).toContain("status: running");
	}, 15000);

	test("进程结束后 bg 文件包含终态元数据", async () => {
		// 使用一个短暂运行后退出的脚本（但超过 waitfor）
		const result = await collectResult(
			'await Bun.sleep(3000); console.log("done");',
			1,
			"bun",
		);

		expect(result.status).toBe("backgrounded");
		if (result.status !== "backgrounded") return;

		pidsToCleanup.push(result.pid);
		filesToCleanup.push(result.logFile);

		// 等待进程结束 + 最终写入
		await new Promise((r) => setTimeout(r, 5000));

		const content = readFileSync(result.logFile, "utf-8");

		// 验证终态元数据
		expect(content).toContain("status: exited");
		expect(content).toContain("exit_code: 0");
		expect(content).toContain("ended_at:");
		expect(content).toContain("duration:");
		expect(content).toContain("last_updated:");
		// 验证输出被捕获
		expect(content).toContain("done");
		// 不应再有 running 相关的 note
		expect(content).not.toContain("note:");
	}, 12000);

	test("新输出能被同步到 bg 文件", async () => {
		// 每秒输出一行，总共输出 8 行
		const script = [
			"for (let i = 1; i <= 8; i++) {",
			"  console.log(`output_line_${i}`);",
			"  await Bun.sleep(1000);",
			"}",
		].join("\n");
		const result = await collectResult(script, 2, "bun");

		expect(result.status).toBe("backgrounded");
		if (result.status !== "backgrounded") return;

		pidsToCleanup.push(result.pid);
		filesToCleanup.push(result.logFile);

		// waitfor=2s 时大约捕获了 1-2 行
		// 等待 5 秒后应该有更多行被同步
		await new Promise((r) => setTimeout(r, 5000));

		const content = readFileSync(result.logFile, "utf-8");
		// 应该能看到超过 waitfor 时间内产生的行
		const lineMatches = content.match(/output_line_\d+/g) || [];
		expect(lineMatches.length).toBeGreaterThanOrEqual(4);
	}, 15000);

	test("bg 文件 mtime 在进程运行期间持续推进（回归：旧版中间停滞）", async () => {
		// 每秒输出一行，持续 12 秒
		const script = [
			"for (let i = 1; i <= 12; i++) {",
			"  console.log(`[t=${i}s] heartbeat`);",
			"  await Bun.sleep(1000);",
			"}",
		].join("\n");
		const result = await collectResult(script, 2, "bun");

		expect(result.status).toBe("backgrounded");
		if (result.status !== "backgrounded") return;

		pidsToCleanup.push(result.pid);
		filesToCleanup.push(result.logFile);

		// 在进程运行期间多次采样 mtime，验证文件持续被更新
		const mtimes: number[] = [];
		for (let i = 0; i < 3; i++) {
			await new Promise((r) => setTimeout(r, 3500));
			const stat = Bun.file(result.logFile);
			// Bun.file().lastModified 返回 ms timestamp
			mtimes.push(stat.lastModified);
		}

		// 每次采样的 mtime 都应该比上一次更大（文件在持续更新）
		expect(mtimes[1]!).toBeGreaterThan(mtimes[0]!);
		expect(mtimes[2]!).toBeGreaterThan(mtimes[1]!);

		// 最终等进程结束，检查内容完整
		await new Promise((r) => setTimeout(r, 4000));
		const content = readFileSync(result.logFile, "utf-8");
		expect(content).toContain("status: exited");
		const heartbeats = (content.match(/heartbeat/g) || []).length;
		expect(heartbeats).toBe(12);
	}, 25000);
});
