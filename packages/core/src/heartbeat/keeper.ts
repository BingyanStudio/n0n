/**
 * HeartbeatKeeper — 缓存保活状态机（纯逻辑层）
 *
 * 管理 prompt cache 的心跳刷新。只在 agent 空闲（等待用户输入）期间工作。
 *
 * 状态：
 *   STOPPED  — 未启动 / agent 运行中
 *   TICKING  — 定时心跳中，缓存存活
 *   EXPIRED  — 缓存已失效，终态（需要新的 start() 重置）
 *
 * 定时器依赖通过 Clock 接口注入，便于测试。
 */

import type { StreamRequest } from "@n0n/types";

// ── Clock 抽象 ──

export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(id: unknown): void;
}

/** 真实 Clock 实现（生产用） */
export const realClock: Clock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

// ── 状态枚举 ──

export enum HeartbeatState {
	STOPPED = "stopped",
	TICKING = "ticking",
	EXPIRED = "expired",
}

// ── 回调接口 ──

export interface HeartbeatCallbacks {
	/** 执行一次心跳请求，返回是否成功 */
	sendHeartbeat: (request: StreamRequest) => Promise<boolean>;
	/** 心跳成功 tick 后通知（含当前次数） */
	onTick?: (count: number, maxCount: number) => void;
	/** 进入 EXPIRED 状态时通知 */
	onExpired?: (reason: "idle" | "max_count" | "error") => void;
}

// ── 配置 ──

export interface HeartbeatConfig {
	/** 心跳间隔（ms），应略小于 cache TTL。默认 240_000（4 分钟） */
	intervalMs?: number;
	/** 最大心跳次数。默认 10（~40 分钟） */
	maxCount?: number;
	/** cache TTL（ms）。默认 300_000（5 分钟） */
	cacheTtlMs?: number;
}

const DEFAULT_INTERVAL_MS = 240_000; // 4 分钟
const DEFAULT_MAX_COUNT = 10;
const DEFAULT_CACHE_TTL_MS = 300_000; // 5 分钟

// ── HeartbeatKeeper ──

export class HeartbeatKeeper {
	private readonly intervalMs: number;
	private readonly maxCount: number;
	private readonly cacheTtlMs: number;
	private readonly clock: Clock;
	private readonly callbacks: HeartbeatCallbacks;

	private _state: HeartbeatState = HeartbeatState.STOPPED;
	private _count = 0;
	/** 最后一次缓存被刷新的时刻（心跳成功 或 start() 时） */
	private _lastRefreshTime = -Infinity;
	private _lastRequest: StreamRequest | null = null;
	private _tickTimer: unknown = null;

	constructor(
		callbacks: HeartbeatCallbacks,
		config: HeartbeatConfig = {},
		clock: Clock = realClock,
	) {
		this.callbacks = callbacks;
		this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.maxCount = config.maxCount ?? DEFAULT_MAX_COUNT;
		this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.clock = clock;
	}

	get state(): HeartbeatState {
		return this._state;
	}

	get count(): number {
		return this._count;
	}

	get lastRefreshTime(): number {
		return this._lastRefreshTime;
	}

	/**
	 * 缓存是否仍然存活（基于上次刷新时间 + TTL）。
	 * 外部也可用此判断当前缓存状态。
	 */
	isCacheAlive(): boolean {
		return this.clock.now() - this._lastRefreshTime < this.cacheTtlMs;
	}

	/**
	 * 启动心跳。
	 *
	 * 在 agent 执行结束后调用。此时缓存刚被 stream/工具调用刷新过，
	 * 所以 start() 记录当前时刻为 lastRefreshTime。
	 */
	start(request: StreamRequest): void {
		this.clearTimer();
		this._state = HeartbeatState.TICKING;
		this._count = 0;
		this._lastRefreshTime = this.clock.now();
		this._lastRequest = request;
		this.scheduleNextTick();
	}

	/**
	 * 停止心跳。
	 *
	 * 在用户提交消息、agent 即将执行时调用。
	 * 回到 STOPPED，下次 agent 结束后可再次 start()。
	 */
	stop(): void {
		this.clearTimer();
		this._state = HeartbeatState.STOPPED;
	}

	/**
	 * 用户按键信号。
	 *
	 * 如果缓存还活着但处于 TICKING，这只是一个"用户还在"的信号，
	 * 不影响心跳调度本身（心跳是固定间隔的）。
	 *
	 * 真正的作用：如果当前因为没有按键而临近 idle 判定，
	 * 这个信号让我们知道用户还在。但在当前设计中我们不用 idle 计时器了——
	 * 我们直接用 isCacheAlive() 判断。所以 keystroke 不需要做任何事。
	 *
	 * 保留此方法作为扩展点。
	 */
	onKeystroke(): void {
		// 当前设计中不需要额外动作。
		// 心跳是固定间隔调度的，不受按键影响。
		// 缓存是否存活由 lastRefreshTime + TTL 精确判定。
	}

	// ── 内部 ──

	private scheduleNextTick(): void {
		this._tickTimer = this.clock.setTimeout(() => this.tick(), this.intervalMs);
	}

	private async tick(): Promise<void> {
		this._tickTimer = null;

		if (this._state !== HeartbeatState.TICKING) return;

		// 在发送心跳前检查：缓存是否已经过期？
		// 正常不会发生（心跳间隔 < TTL），但作为防御性检查。
		if (!this.isCacheAlive()) {
			this.expire("idle");
			return;
		}

		// 检查次数上限
		if (this._count >= this.maxCount) {
			this.expire("max_count");
			return;
		}

		let ok: boolean;
		try {
			if (!this._lastRequest) {
				ok = false;
			} else {
				ok = await this.callbacks.sendHeartbeat(this._lastRequest);
			}
		} catch {
			ok = false;
		}

		// tick 完成后再次检查状态（异步期间可能被 stop() 了）
		if (this._state !== HeartbeatState.TICKING) return;

		if (!ok) {
			this.expire("error");
			return;
		}

		this._count++;
		this._lastRefreshTime = this.clock.now();
		this.callbacks.onTick?.(this._count, this.maxCount);

		// 再次检查次数（刚 count++ 可能已到上限）
		if (this._count >= this.maxCount) {
			this.expire("max_count");
			return;
		}

		this.scheduleNextTick();
	}

	private expire(reason: "idle" | "max_count" | "error"): void {
		this.clearTimer();
		this._state = HeartbeatState.EXPIRED;
		this.callbacks.onExpired?.(reason);
	}

	private clearTimer(): void {
		if (this._tickTimer != null) {
			this.clock.clearTimeout(this._tickTimer);
			this._tickTimer = null;
		}
	}
}
