# exec timeout 修复方案

## 问题诊断

### 现状分析

`packages/tools/src/exec.ts` 的 `execToolStream` 函数中，timeout 相关代码如下：

```typescript
const timer = setTimeout(() => {
    proc.kill();
}, timeoutMs);

// ... 读取 stdout/stderr 流 ...

const exitCode = await proc.exited;
clearTimeout(timer);
```

### 确认的问题

**timeout 参数名存实亡，存在三个严重缺陷：**

1. **超时 = 直接杀死进程**：`setTimeout` 触发后调用 `proc.kill()`，进程被强制终止。工具描述中声称 "Process continues in background if exceeded"，但实际并未实现后台继续执行。

2. **无超时通知**：进程被 kill 后，代码继续走正常流程 `await proc.exited`，拿到一个非零退出码，但模型无法区分"脚本执行失败"和"脚本因超时被终止"。没有任何特殊标识告知模型这是一次超时。

3. **无输出保留**：进程被杀后，已产生的 stdout/stderr 虽然在 chunks 里收集了，但没有写入持久化文件。模型无法在之后查看"超时前已经输出了什么"。此外，临时脚本文件在 `finally` 块中被立即删除，后台执行也无从谈起。

## 修复方案

### 核心思路

超时时**不杀进程**，而是将其**分离到后台**，把已收集的输出写入 `.temp/` 文件，然后向模型返回一个特殊的超时通知结果。

### 具体改动

#### 1. `packages/tools/src/exec.ts` — `execToolStream` 函数

**超时处理逻辑重写：**

```
原来：setTimeout → proc.kill() → 正常收集结果
改为：setTimeout → 设置 timedOut 标志 → 中断流读取循环 → 返回超时结果
```

关键变更：
- 引入 `timedOut` 标志变量，`setTimeout` 回调中仅设置标志，不杀进程
- 流读取循环中检测 `timedOut`，一旦超时立即跳出循环
- 超时后，将已收集的 stdout/stderr 写入 `.temp/exec_bg_{pid}_{timestamp}.log`
- 启动一个 detached 的后台协程继续消费 stdout/stderr 并追加写入日志文件
- 不再在 `finally` 中删除临时脚本文件（后台进程仍需要它）
- yield 一个特殊的 `ExecToolResult`，包含超时通知信息

**超时返回内容示例：**
```
⏱ exec 执行超时（超过 {timeout}s），已切换至后台继续执行。
PID: {pid}
已捕获输出已写入: .temp/exec_bg_{pid}_{timestamp}.log
请等待后读取该文件了解进程执行状况。
```

#### 2. `packages/types/src/domain.ts` — ExecToolResult 类型

考虑是否需要扩展类型。有两种方案：

- **方案 A（推荐 — 最小改动）**：不改类型，超时信息通过 `stderr` 字段传递，`exitCode` 设为特殊值（如 `124`，与 GNU timeout 一致）。超时详情文本写入 stdout。
- **方案 B**：在 `ExecToolResult` 中新增可选字段 `timedOut?: boolean`、`backgroundPid?: number`、`logFile?: string`。

推荐方案 A，因为：
- 不需要改动类型系统，减少跨包影响
- exitCode 124 是 Unix 下 `timeout` 命令的惯例，语义清晰
- 模型通过 stdout/stderr 文本即可理解状况

#### 3. `packages/shared/src/format-prompt.ts` — 格式化展示

`formatExecResult` 中 `exec_meta` 标签已包含 exit code 和耗时，如果采用方案 A，模型能自然看到 `[exit: 124]` + 超时说明文本，**无需额外改动**。

#### 4. 后台进程日志文件管理

- 文件路径：`.temp/exec_bg_{pid}_{timestamp}.log`
- 文件格式：纯文本，先写入已收集的输出，后续追加新输出
- 进程结束后，在日志末尾追加 `\n--- Process exited with code {exitCode} ---`
- **不做自动清理**，交给用户/模型自行管理

#### 5. 临时脚本文件的生命周期

超时场景下：
- 不在 `finally` 中删除临时脚本文件
- 后台协程在进程退出后负责清理脚本文件

正常场景下：
- 行为不变，`finally` 中删除

### 实现要点

```typescript
// 伪代码概要
let timedOut = false;

const timer = setTimeout(() => {
    timedOut = true;
    notify?.();  // 唤醒流读取循环
}, timeoutMs);

// 流读取循环增加超时检测
while (streamsDone < 2 || pending.length > 0) {
    if (timedOut) break;  // ← 新增
    // ... 原有逻辑 ...
}

if (timedOut) {
    clearTimeout(timer);
    const pid = proc.pid;
    const logFile = join(tempDir, `exec_bg_${pid}_${Date.now()}.log`);
    
    // 写入已收集的输出
    await Bun.write(logFile, collectedOutput);
    
    // 启动后台协程继续收集输出
    spawnBackgroundCollector(proc, logFile, tmpFile);
    
    // 返回超时通知
    yield {
        type: "tool_result",
        tool: "exec",
        call,
        exitCode: 124,
        stdout: `⏱ exec 脚本执行超过 ${call.args.timeout ?? toolsConfig.defaultExecTimeout}s，已转入后台继续执行。\nPID: ${pid}\n已捕获的输出写入: ${logFile}\n可稍后读取该文件了解进程执行状况。`,
        stderr: stdoutChunks.join("") + stderrChunks.join(""),
        durationMs: Date.now() - start,
    };
    return;  // 不进入 finally 的删除逻辑
}
```

### 影响范围

| 包 | 文件 | 改动程度 |
|---|---|---|
| `@n0n/tools` | `src/exec.ts` | **主要改动** — 超时逻辑重写 |
| `@n0n/types` | 无 | 不改动（方案 A） |
| `@n0n/shared` | 无 | 不改动 |

### 测试计划

1. **正常执行**：确认无超时时行为不变
2. **超时触发**：执行 `sleep 10` 设 timeout=2，验证：
   - 返回 exitCode 124
   - stdout 包含 PID 和日志文件路径
   - 日志文件已创建且包含已收集的输出
   - 后台进程仍在运行
3. **后台进程结束**：等待后台进程完成，验证日志文件末尾有退出码
4. **临时文件清理**：后台进程结束后临时脚本文件被删除
