/**
 * HeartbeatKeeper 纯逻辑测试
 *
 * 使用假时钟精确控制时间推进，验证所有状态转换。
 */

import { describe, expect, test } from "bun:test";
import type { StreamRequest } from "@n0n/types";
import {
	type Clock,
	type HeartbeatCallbacks,
	HeartbeatKeeper,
	HeartbeatState,
} from "../keeper.ts";

const dummyRequest: StreamRequest = {
	messages: [{ type: "system", content: "test" }],
	tools: [],
	toolChoice: "auto",
};

// ── 假时钟 ──

interface ScheduledTimer {
	id: number;
	fn: () => void;
	fireAt: number;
}

class FakeClock implements Clock {
	private _now = 0;
	private _nextId = 1;
	private _timers: ScheduledTimer[] = [];

	now(): number {
		return this._now;
	}

	setTimeout(fn: () => void, ms: number): number {
		const id = this._nextId++;
		this._timers.push({ id, fn, fireAt: this._now + ms });
		return id;
	}

	clearTimeout(id: unknown): void {
		this._timers = this._timers.filter((t) => t.id !== id);
	}

	/**
	 * 推进时间到指定时刻，触发沿途所有到期的定时器（按时间顺序）。
	 * 返回一个 promise 以等待异步 tick 完成。
	 */
	async advance(ms: number): Promise<void> {
		const target = this._now + ms;
		while (true) {
			// 找最早的到期定时器
			const due = this._timers
				.filter((t) => t.fireAt <= target)
				.sort((a, b) => a.fireAt - b.fireAt)[0];
			if (!due) break;
			this._timers = this._timers.filter((t) => t.id !== due.id);
			this._now = due.fireAt;
			due.fn();
			// Flush microtask queue — tick() is async and needs multiple awaits
			for (let i = 0; i < 10; i++) await Promise.resolve();
		}
		this._now = target;
	}

	get pendingTimers(): number {
		return this._timers.length;
	}
}

// ── 辅助工厂 ──

interface TestContext {
	clock: FakeClock;
	keeper: HeartbeatKeeper;
	heartbeatCalls: number;
	ticks: Array<{ count: number; maxCount: number }>;
	expirations: Array<"idle" | "max_count" | "error">;
	heartbeatShouldSucceed: boolean;
}

function setup(config?: {
	intervalMs?: number;
	maxCount?: number;
	cacheTtlMs?: number;
}): TestContext {
	const ctx: TestContext = {
		clock: new FakeClock(),
		keeper: null as unknown as HeartbeatKeeper,
		heartbeatCalls: 0,
		ticks: [],
		expirations: [],
		heartbeatShouldSucceed: true,
	};

	const callbacks: HeartbeatCallbacks = {
		sendHeartbeat: async (_request: StreamRequest) => {
			ctx.heartbeatCalls++;
			return ctx.heartbeatShouldSucceed;
		},
		onTick: (count, maxCount) => {
			ctx.ticks.push({ count, maxCount });
		},
		onExpired: (reason) => {
			ctx.expirations.push(reason);
		},
	};

	ctx.keeper = new HeartbeatKeeper(callbacks, config, ctx.clock);
	return ctx;
}

// ── 测试 ──

describe("HeartbeatKeeper", () => {
	// ── 基础生命周期 ──

	test("初始状态是 STOPPED", () => {
		const { keeper } = setup();
		expect(keeper.state).toBe(HeartbeatState.STOPPED);
		expect(keeper.count).toBe(0);
	});

	test("start() → TICKING", () => {
		const { keeper } = setup();
		keeper.start(dummyRequest);
		expect(keeper.state).toBe(HeartbeatState.TICKING);
		expect(keeper.count).toBe(0);
		expect(keeper.isCacheAlive()).toBe(true);
	});

	test("start() 后 stop() → STOPPED", () => {
		const { keeper } = setup();
		keeper.start(dummyRequest);
		keeper.stop();
		expect(keeper.state).toBe(HeartbeatState.STOPPED);
	});

	// ── 正常心跳流程 ──

	test("每个 interval 发一次心跳", async () => {
		const ctx = setup({ intervalMs: 4000, cacheTtlMs: 5000 });
		ctx.keeper.start(dummyRequest);

		// 推进到第一个 interval
		await ctx.clock.advance(4000);
		expect(ctx.heartbeatCalls).toBe(1);
		expect(ctx.ticks).toEqual([{ count: 1, maxCount: 10 }]);
		expect(ctx.keeper.state).toBe(HeartbeatState.TICKING);

		// 推进到第二个 interval
		await ctx.clock.advance(4000);
		expect(ctx.heartbeatCalls).toBe(2);
		expect(ctx.ticks).toEqual([
			{ count: 1, maxCount: 10 },
			{ count: 2, maxCount: 10 },
		]);
	});

	test("心跳刷新 lastRefreshTime", async () => {
		const ctx = setup({ intervalMs: 4000, cacheTtlMs: 5000 });
		ctx.keeper.start(dummyRequest); // t=0, lastRefreshTime=0

		await ctx.clock.advance(4000); // t=4000, 心跳成功
		expect(ctx.keeper.lastRefreshTime).toBe(4000);
		expect(ctx.keeper.isCacheAlive()).toBe(true);
	});

	// ── 场景：用户 6 分钟后开始打字 ──

	test("用户 6 分钟后开始打字 — 缓存仍活着", async () => {
		const ctx = setup({ intervalMs: 240_000, cacheTtlMs: 300_000 });
		ctx.keeper.start(dummyRequest); // t=0

		// 第 4 分钟：第一次心跳
		await ctx.clock.advance(240_000);
		expect(ctx.heartbeatCalls).toBe(1);
		expect(ctx.keeper.isCacheAlive()).toBe(true);

		// 第 6 分钟：用户开始打字。缓存在第 4 分钟刷新过，TTL 5 分钟，到第 9 分钟才过期。
		await ctx.clock.advance(120_000); // 推进到 t=360_000 (6min)
		expect(ctx.keeper.isCacheAlive()).toBe(true);
		expect(ctx.keeper.state).toBe(HeartbeatState.TICKING);

		// 第 8 分钟：第二次心跳
		await ctx.clock.advance(120_000);
		expect(ctx.heartbeatCalls).toBe(2);
		expect(ctx.keeper.isCacheAlive()).toBe(true);
	});

	// ── 场景：用户 10 分钟后才回来（缓存已过期）──

	test("用户 10 分钟未操作 — 心跳在缓存过期前停止？", async () => {
		// interval=4min, TTL=5min
		// t=0: start (lastRefresh=0)
		// t=4min: 心跳1 (lastRefresh=4min)
		// t=8min: 心跳2，但先检查 isCacheAlive: lastRefresh=4min, now=8min, 差4min < 5min TTL → 还活
		// t=8min: 心跳2 成功 (lastRefresh=8min)
		// t=12min: 心跳3 (lastRefresh=12min)
		// ...心跳一直在跳，不会因为"用户没按键"而停
		const ctx = setup({ intervalMs: 240_000, cacheTtlMs: 300_000 });
		ctx.keeper.start(dummyRequest);

		await ctx.clock.advance(600_000); // 10 分钟
		// 10min 内发了 2 次心跳 (t=4min, t=8min)
		expect(ctx.heartbeatCalls).toBe(2);
		expect(ctx.keeper.state).toBe(HeartbeatState.TICKING);
		// lastRefresh=8min, now=10min, 差2min < 5min → 缓存还活
		expect(ctx.keeper.isCacheAlive()).toBe(true);
	});

	// ── maxCount 到达 ──

	test("达到 maxCount → EXPIRED(max_count)", async () => {
		const ctx = setup({ intervalMs: 100, cacheTtlMs: 200, maxCount: 3 });
		ctx.keeper.start(dummyRequest);

		await ctx.clock.advance(100); // tick 1
		await ctx.clock.advance(100); // tick 2
		await ctx.clock.advance(100); // tick 3 → count=3 → expire

		expect(ctx.heartbeatCalls).toBe(3);
		expect(ctx.keeper.count).toBe(3);
		expect(ctx.keeper.state).toBe(HeartbeatState.EXPIRED);
		expect(ctx.expirations).toEqual(["max_count"]);

		// EXPIRED 后不再调度
		await ctx.clock.advance(1000);
		expect(ctx.heartbeatCalls).toBe(3);
	});

	// ── 心跳失败 ──

	test("心跳请求失败 → EXPIRED(error)", async () => {
		const ctx = setup({ intervalMs: 100, cacheTtlMs: 200 });
		ctx.keeper.start(dummyRequest);

		await ctx.clock.advance(100); // tick 1 成功
		expect(ctx.heartbeatCalls).toBe(1);

		ctx.heartbeatShouldSucceed = false;
		await ctx.clock.advance(100); // tick 2 失败 → expire

		expect(ctx.heartbeatCalls).toBe(2);
		expect(ctx.keeper.state).toBe(HeartbeatState.EXPIRED);
		expect(ctx.expirations).toEqual(["error"]);
	});

	// ── stop() 中断 ──

	test("TICKING 期间 stop() → STOPPED，不再心跳", async () => {
		const ctx = setup({ intervalMs: 100, cacheTtlMs: 200 });
		ctx.keeper.start(dummyRequest);

		await ctx.clock.advance(100); // tick 1
		expect(ctx.heartbeatCalls).toBe(1);

		ctx.keeper.stop(); // 用户提交了消息
		expect(ctx.keeper.state).toBe(HeartbeatState.STOPPED);

		await ctx.clock.advance(500);
		expect(ctx.heartbeatCalls).toBe(1); // 没有更多心跳
	});

	// ── EXPIRED 是终态，必须重新 start() ──

	test("EXPIRED 后 start() → 重置为 TICKING", async () => {
		const ctx = setup({ intervalMs: 100, cacheTtlMs: 200, maxCount: 1 });
		ctx.keeper.start(dummyRequest);

		await ctx.clock.advance(100); // tick 1 → count=1 → expire
		expect(ctx.keeper.state).toBe(HeartbeatState.EXPIRED);

		// 模拟 agent 再次执行完毕，重新 start
		ctx.keeper.start(dummyRequest);
		expect(ctx.keeper.state).toBe(HeartbeatState.TICKING);
		expect(ctx.keeper.count).toBe(0);

		await ctx.clock.advance(100); // tick 1 again
		expect(ctx.heartbeatCalls).toBe(2); // 累计
		expect(ctx.keeper.count).toBe(1);
	});

	// ── stop() 后也可以重新 start() ──

	test("STOPPED 后 start() → TICKING", async () => {
		const ctx = setup({ intervalMs: 100, cacheTtlMs: 200 });
		ctx.keeper.start(dummyRequest);
		ctx.keeper.stop();

		ctx.keeper.start(dummyRequest);
		expect(ctx.keeper.state).toBe(HeartbeatState.TICKING);

		await ctx.clock.advance(100);
		expect(ctx.heartbeatCalls).toBe(1);
	});

	// ── 完整会话模拟 ──

	test("完整会话：agent→等待→用户打字→提交→agent→等待", async () => {
		const ctx = setup({ intervalMs: 4000, cacheTtlMs: 5000, maxCount: 20 });

		// === 第一轮 agent 结束 ===
		ctx.keeper.start(dummyRequest); // t=0
		expect(ctx.keeper.state).toBe(HeartbeatState.TICKING);

		// 用户思考中，心跳保活
		await ctx.clock.advance(4000); // t=4s, tick 1
		expect(ctx.heartbeatCalls).toBe(1);

		await ctx.clock.advance(3000); // t=7s, 用户开始打字
		ctx.keeper.onKeystroke(); // 不影响状态，只是信号
		expect(ctx.keeper.state).toBe(HeartbeatState.TICKING);

		await ctx.clock.advance(1000); // t=8s, tick 2
		expect(ctx.heartbeatCalls).toBe(2);

		await ctx.clock.advance(2000); // t=10s, 用户提交
		ctx.keeper.stop();
		expect(ctx.keeper.state).toBe(HeartbeatState.STOPPED);

		// === agent 第二轮执行（无心跳）===
		await ctx.clock.advance(30000); // agent 跑了 30s
		expect(ctx.heartbeatCalls).toBe(2); // 没有新心跳

		// === 第二轮 agent 结束 ===
		ctx.keeper.start(dummyRequest); // 重新启动
		expect(ctx.keeper.state).toBe(HeartbeatState.TICKING);
		expect(ctx.keeper.count).toBe(0); // 计数器归零

		await ctx.clock.advance(4000); // tick 1 of round 2
		expect(ctx.heartbeatCalls).toBe(3);
	});

	// ── 边界：interval >= TTL（配置错误保护）──

	test("如果 interval >= TTL，第一次 tick 时缓存仍活", async () => {
		// interval=5000, TTL=5000 → 恰好在边界
		// t=0: start (lastRefresh=0)
		// t=5000: tick，now-lastRefresh=5000，不 < 5000 → cache dead → expire
		const ctx = setup({ intervalMs: 5000, cacheTtlMs: 5000 });
		ctx.keeper.start(dummyRequest);

		await ctx.clock.advance(5000);
		// 缓存恰好过期，心跳来不及 → expire
		expect(ctx.keeper.state).toBe(HeartbeatState.EXPIRED);
		expect(ctx.expirations).toEqual(["idle"]);
		expect(ctx.heartbeatCalls).toBe(0); // 没发出心跳就 expire 了
	});

	// ── sendHeartbeat 抛异常 ──

	test("sendHeartbeat 抛异常 → EXPIRED(error)", async () => {
		const clock = new FakeClock();
		let calls = 0;
		const keeper = new HeartbeatKeeper(
			{
				sendHeartbeat: async () => {
					calls++;
					throw new Error("network failure");
				},
				onExpired: () => {},
			},
			{ intervalMs: 100, cacheTtlMs: 200 },
			clock,
		);

		keeper.start(dummyRequest);
		await clock.advance(100);

		expect(calls).toBe(1);
		expect(keeper.state).toBe(HeartbeatState.EXPIRED);
	});

	// ── isCacheAlive 在各状态下的表现 ──

	test("isCacheAlive — STOPPED 且从未 start 过 → false", () => {
		const ctx = setup({ cacheTtlMs: 5000 });
		expect(ctx.keeper.isCacheAlive()).toBe(false);
	});

	test("isCacheAlive — start 后立即检查 → true", () => {
		const ctx = setup({ cacheTtlMs: 5000 });
		ctx.keeper.start(dummyRequest);
		expect(ctx.keeper.isCacheAlive()).toBe(true);
	});

	test("isCacheAlive — 超过 TTL 后 → false", async () => {
		const ctx = setup({ intervalMs: 100, cacheTtlMs: 200, maxCount: 1 });
		ctx.keeper.start(dummyRequest);
		await ctx.clock.advance(100); // tick → expire (maxCount=1)

		// lastRefresh=100, 推进到 350 → 差 250 > 200 TTL
		await ctx.clock.advance(250);
		expect(ctx.keeper.isCacheAlive()).toBe(false);
	});

	// ── 用户主动离开 ──

	test("用户主动 stop — 心跳立即停止，不触发 onExpired", async () => {
		const ctx = setup({ intervalMs: 100, cacheTtlMs: 200, maxCount: 20 });
		ctx.keeper.start(dummyRequest);

		await ctx.clock.advance(100); // tick 1
		expect(ctx.heartbeatCalls).toBe(1);

		// 用户说 byebye
		ctx.keeper.stop();
		expect(ctx.keeper.state).toBe(HeartbeatState.STOPPED);
		expect(ctx.expirations).toEqual([]); // 不触发 onExpired

		// 之后不再心跳
		await ctx.clock.advance(1000);
		expect(ctx.heartbeatCalls).toBe(1);

		// 用户第二天回来，提交消息，agent 执行完毕，重新 start
		ctx.keeper.start(dummyRequest);
		expect(ctx.keeper.state).toBe(HeartbeatState.TICKING);
		expect(ctx.keeper.count).toBe(0);
		expect(ctx.keeper.isCacheAlive()).toBe(true);

		await ctx.clock.advance(100);
		expect(ctx.heartbeatCalls).toBe(2);
	});
});
