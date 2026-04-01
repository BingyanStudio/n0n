# exec timeout 修复方案

## 问题诊断

### 现状代码（关键路径）

```typescript
// 1. 启动进程
const proc = Bun.spawn(spawnCmd, { cwd, stdout: "pipe", stderr: "pipe" });

// 2. 注册定时器
const timer = setTimeout(() => { proc.kill(); }, timeoutMs);

// 3. 流读取循环（阻塞点）
while (streamsDone < 2 || pending.length > 0) {
    if (pending.length === 0) {
        await new Promise<void>((r) => { notify = r; });  // ← 卡死在这里
    }
    while (pending.length > 0) { yield pending.shift(); }
}

// 4. 等待进程退出
const exitCode = await proc.exited;
clearTimeout(timer);
```

### 根本原因：timeout 完全不生效

`setTimeout → proc.kill()` 的方案依赖一个脆弱的假设：**kill 信号一定能让 stdout/stderr 流关闭，从而让 `reader.read()` 返回 `done: true`，进而 `streamsDone++` 并 `notify()` 唤醒主循环。**

实际上这个假设经常不成立：

1. **进程组问题**：shell 脚本（sh/bash）会 fork 子进程。`proc.kill()` 只发信号给直接子进程（shell 本身），子进程继续持有 stdout/stderr 管道，流永远不关闭。
2. **SIGTERM 被忽略**：某些进程捕获或忽略 SIGTERM，不退出。
3. **管道继承**：即使父进程退出，子进程继承了管道 fd，流依然保持打开状态。

结果：`while` 循环中的 `await new Promise(...)` 永远不被 resolve，**整个 AsyncGenerator 永久阻塞，agent 主循环卡死**。

用户的观察完全正确：脚本阻塞时，从未看到进程被终止——因为即使 `proc.kill()` 执行了，流读取循环也出不来。

### 架构缺陷

超时机制（`setTimeout`）和它要中断的目标（流读取 `while` 循环）运行在**同一个 async 流程中**，靠 kill 信号间接触发流关闭来"通知"循环退出。这是一个脆弱的间接依赖，不是确定性的中断机制。

## 修复方案

### 1. 超时中断机制：`Promise.race` 替代间接 kill

用 `Promise.race` 让超时 Promise 与流读取 Promise 竞争，**确定性地中断等待**：

```typescript
let timedOut = false;
const timeoutPromise = new Promise<"timeout">((resolve) => {
    setTimeout(() => { timedOut = true; resolve("timeout"); }, timeoutMs);
});

// 流读取循环中
while (streamsDone < 2 || pending.length > 0) {
    if (timedOut) break;                    // ← 超时立即跳出
    if (pending.length === 0) {
        const waitForData = new Promise<"data">((r) => { notify = () => r("data"); });
        const result = await Promise.race([waitForData, timeoutPromise]);
        if (result === "timeout") break;    // ← 确定性中断
    }
    while (pending.length > 0) { yield pending.shift(); }
}
```

### 2. 超时后的处理流程

```
超时触发
  → 中断流读取循环
  → 将已收集的 stdout/stderr 写入 .temp/exec_bg_{pid}_{timestamp}.log
  → 启动 detached 后台协程继续消费流并追加写入日志
  → yield 超时结果（含 pid、logFile 等结构化数据）
  → 不删除临时脚本文件（后台进程仍需要）
  → 后台协程在进程退出后清理临时脚本文件
```

### 3. 类型扩展（必须）

遵循 domain-message.md 的设计原则：**DomainMessage 是纯粹的数据记录，不应包含提示词**。超时结果必须通过显式的结构化字段表达，而非字符串约定。

**`packages/types/src/domain.ts` — ExecToolResult 改为判别联合：**

```typescript
/** exec 正常完成 */
interface ExecCompleted {
    type: "tool_result";
    tool: "exec";
    call: ExecToolCall;
    /** 是否超时 — 判别字段 */
    timedOut: false;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
}

/** exec 超时，进程转入后台 */
interface ExecTimedOut {
    type: "tool_result";
    tool: "exec";
    call: ExecToolCall;
    /** 是否超时 — 判别字段 */
    timedOut: true;
    /** 后台进程 PID */
    pid: number;
    /** 后台日志文件路径 */
    logFile: string;
    /** 超时前已捕获的 stdout */
    stdoutSoFar: string;
    /** 超时前已捕获的 stderr */
    stderrSoFar: string;
    /** 超时时长（ms） */
    durationMs: number;
}

export type ExecToolResult = ExecCompleted | ExecTimedOut;
```

这样做的优势：
- **类型安全**：通过 `timedOut` 判别字段，TypeScript 可以窄化类型，消费方必须处理两种情况
- **纯数据结构**：pid、logFile、stdoutSoFar 都是数据，不含任何提示词文本
- **可持久化/可重放**：符合 domain-message.md 的设计原则

### 4. 格式化层适配

**`packages/shared/src/format-prompt.ts` — `formatExecResult` 函数：**

```typescript
function formatExecResult(msg: ExecToolResult, model: string): string {
    if (msg.timedOut) {
        const meta = `[${msg.call.args.runtime ?? "unknown"}] [cwd: ${msg.call.args.cwd ?? "."}] [timed out after ${msg.durationMs}ms]`;
        const parts = [wrapTag("exec_meta", meta, model)];
        const notice = [
            `Process exceeded timeout, moved to background.`,
            `PID: ${msg.pid}`,
            `Log file: ${msg.logFile}`,
            `Read the log file later to check process status.`,
        ].join("\n");
        parts.push(wrapTag("timeout_notice", notice, model));
        if (msg.stdoutSoFar) parts.push(wrapTag("stdout", msg.stdoutSoFar, model));
        if (msg.stderrSoFar) parts.push(wrapTag("stderr", msg.stderrSoFar, model));
        return parts.join("\n");
    }

    // 正常路径（不变）
    const meta = `[${msg.call.args.runtime ?? "unknown"}] [cwd: ${msg.call.args.cwd ?? "."}] [exit: ${msg.exitCode}] [${msg.durationMs}ms]`;
    const parts = [wrapTag("exec_meta", meta, model)];
    if (msg.stdout) parts.push(wrapTag("stdout", msg.stdout, model));
    if (msg.stderr) parts.push(wrapTag("stderr", msg.stderr, model));
    return parts.join("\n");
}
```

### 5. 后台日志文件管理

- 路径：`.temp/exec_bg_{pid}_{timestamp}.log`
- 格式：纯文本，先写入已收集输出，后续追加
- 进程结束后追加 `\n--- Process exited with code {exitCode} ---`
- 后台协程在进程退出后删除临时脚本文件
- 日志文件不自动清理，由用户/模型管理

## 改动范围

| 包 | 文件 | 改动 |
|---|---|---|
| `@n0n/types` | `src/domain.ts` | ExecToolResult 改为判别联合（ExecCompleted \| ExecTimedOut） |
| `@n0n/tools` | `src/exec.ts` | 超时逻辑重写：Promise.race 中断 + 后台协程 + 日志写入 |
| `@n0n/shared` | `src/format-prompt.ts` | formatExecResult 处理 timedOut 分支 |

## 测试计划

1. **正常执行**：`echo hello` — 行为不变，`timedOut: false`
2. **超时触发**：`sleep 10` + timeout=2 — 验证 `timedOut: true`、pid、logFile
3. **后台继续**：超时后读取日志文件，确认内容持续更新
4. **进程组场景**：`bash -c 'sleep 100 & wait'` + timeout=2 — 验证不卡死
5. **类型安全**：`tsc --noEmit` 确认所有消费方处理了两种 ExecToolResult
