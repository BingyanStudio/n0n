# Fewshot 教学方案分析

## 核心问题

我们想通过 fewshot（预填充对话历史）同时完成两件事：
1. **教学** — 让模型习得正确的行为模式
2. **信息注入** — 让模型感知当前环境上下文

关键约束：fewshot 的每一轮 assistant turn 都会消耗 token，需要在覆盖面和成本之间找到最优解。

---

## 一、教学能力清单

### 可通过真实执行教学的行为

这些行为可以在「环境初始化」这个真实任务中自然展现，不需要虚构任何场景。

| ID | 行为 | 教学方式 | 真实性 |
|----|------|---------|--------|
| A1 | 并行调用：独立的 write/edit/exec 一次性发出 | 初始化的 Turn 2 中 write+edit+exec+submit 四个调用并行 | 100% 真实 |
| A2 | 脚本替代 shell 链：一个 bun 脚本内聚完成数据收集 | 环境扫描脚本本身就是范例 | 100% 真实 |
| A3 | 先读后改：修改文件前先理解内容 | Turn 1 读取文件内容 → Turn 2 基于理解做修改 | 100% 真实 |
| A5 | 验证后再完成：exec 验证通过才 submit | Turn 2 中 exec 运行脚本验证 | 100% 真实 |
| A6 | 环境感知：知道 OS/tools/shell/working dir | 脚本输出真实环境信息 | 100% 真实 |
| A7 | write vs edit 区分：新文件 write，已有文件 edit | Turn 2 中 write 创建新文件 + edit 修改已有文件 | 100% 真实 |

### 可通过「创造条件」教学的行为

这些行为的教学需要特定前提条件，但我们可以在 bootstrap 阶段预置条件（临时文件），让教学在真实执行中完成。

| ID | 行为 | 需要的条件 | 创造方式 |
|----|------|-----------|---------|
| A11 | 诊断后再修：遇错误先读后修 | 一个会报错的脚本 | 预置 `.temp/hello.ts`（含故意的类型错误），模型运行→看到报错→修复→再运行 |

> **A11 的思维实验**：
> 如果 `.temp/hello.ts` 内容是 `const n: number = "hello"; console.log(n);`，
> 模型在 Turn 2 执行 `bun .temp/hello.ts` 会得到真实的类型错误。
> Turn 3 中模型看到错误信息，edit 修复，再次运行验证通过。
> 整个过程是真实执行，不是硬编码的假结果。代价是多一轮 assistant turn（~400 tokens）。

### 无法在 bootstrap 中教学的行为

这些行为没有「自然土壤」——bootstrap 场景中不会出现这些情况，强行植入会显得割裂。

| ID | 行为 | 为什么不行 | 替代方案 |
|----|------|-----------|---------|
| A9 | git commit 规范 | 不能在 fewshot 中产生真实 commit | 需要 system-reminder 虚构「刚完成功能，准备提交」场景 |
| A10 | reminder 使用 | bootstrap 不是多步任务，设 reminder 不自然 | 需要 system-reminder 虚构复杂任务场景 |
| A12 | ask_user 使用 | bootstrap 没有歧义需要用户决策 | 需要 system-reminder 虚构「发现两种方案」场景 |

---

## 二、信息注入清单

所有信息都在 Turn 1 的环境扫描脚本中一次性获取：

| 信息 | 获取方式 | 示例输出 |
|------|---------|---------|
| 操作系统 | `uname -s` | `Darwin` |
| Shell 类型 | `$SHELL` | `/bin/bash` |
| 可用工具+版本 | `which` + `--version` | `bun: 1.3.9`, `git: 2.39.5`, `rg: 15.1.0` |
| 工作目录 | `process.cwd()` | `/Users/wepie/PieBox/Projects/n0n` |
| 目录结构 | `readdir` | `apps, packages, scripts, docs, ...` |
| AGENTS.md | `readFile` | 完整内容（用户偏好、角色扮演要求等） |
| Git 分支+状态 | `git branch` + `git status` | `mvp`, `clean` |

---

## 三、方案设计

### 方案 A：2-turn 动态 bootstrap（推荐）

覆盖 A1, A2, A3, A5, A6, A7 + 全部信息注入。

**前置准备**（repl.ts 在构建 fewshot 前执行）：
- 写入 `.temp/bootstrap-test.md`

```markdown
# Bootstrap Task
1. Create .temp/hello.ts: console.log("bootstrap ok")
2. Run it to verify bun works
3. Change this file's Status from PENDING to DONE
4. Clean up all temp files

Status: PENDING
```

**Turn 1**（1 个 exec 调用）：

```
assistant → exec({ runtime: "bun", script: <环境扫描脚本> })
```

脚本真实执行，输出：
```
OS: Darwin
Shell: /bin/bash
bun: 1.3.9
node: v20.19.2
git: git version 2.39.5
rg: ripgrep 15.1.0
python3: Python 3.9.6

Git branch: mvp
Git: clean

AGENTS.md:
## 用户偏好
用户喜欢梅比乌斯...
...

Working directory: /Users/wepie/PieBox/Projects/n0n
Top-level: apps, packages, scripts, docs, ...

.temp/ contains: bootstrap-test.md
.temp/bootstrap-test.md:
# Bootstrap Task
1. Create .temp/hello.ts: console.log("bootstrap ok")
...
Status: PENDING
```

教学覆盖：
- **A2**：一个 bun 脚本替代 6+ 条 shell 命令
- **A6**：从输出中自然获知全部环境信息
- **A3（前半）**：主动发现并读取文件内容

**Turn 2**（4 个并行调用）：

```
assistant → [
  write(".temp/hello.ts", 'console.log("bootstrap ok")'),
  edit(".temp/bootstrap-test.md", "Change Status from PENDING to DONE"),
  exec('bun .temp/hello.ts && rm .temp/hello.ts .temp/bootstrap-test.md'),
  submit({ type: "completed", summary: "环境初始化完成。macOS + bun 1.3.9，工作目录 /Users/.../n0n，mvp 分支，工作区干净。AGENTS.md 要求角色扮演。就绪，等待指令。" })
]
```

教学覆盖：
- **A1**：write + edit + exec + submit 四个独立调用一次性发出
- **A7**：write 创建新文件 + edit 修改已有文件，同一批次展现两种工具
- **A3（后半）**：基于 Turn 1 的读取结果做修改
- **A5**：exec 运行脚本验证环境可用 + 清理临时文件

**成本**：~8 条消息，~1000 tokens

### 方案 B：3-turn 动态 bootstrap（额外覆盖 A11）

在方案 A 基础上，预置一个有 bug 的脚本来教学「错误诊断」。

**额外预置**：`.temp/hello.ts`

```typescript
const greeting: number = "bootstrap ok";
console.log(greeting);
```

**Turn 1**（同方案 A）：环境扫描，发现两个临时文件并读取。

**Turn 2**（2 个并行 exec）：

```
assistant → [
  exec('bun .temp/hello.ts'),     // 运行 → 类型错误
]
```

tool_result：
```
error: Type 'string' is not assignable to type 'number'.
  const greeting: number = "bootstrap ok";
                           ~~~~~~~~~~~~~~
```

教学覆盖：
- **A11（前半）**：执行遇到错误，需要诊断

**Turn 3**（4 个并行调用）：

```
assistant → [
  edit(".temp/hello.ts", "Fix type: change 'number' to 'string'"),
  edit(".temp/bootstrap-test.md", "PENDING → DONE"),
  exec('bun .temp/hello.ts && rm .temp/hello.ts .temp/bootstrap-test.md'),
  submit({ type: "completed", summary: "..." })
]
```

教学覆盖：
- **A11（后半）**：读错误信息 → 诊断根因 → 修复 → 验证
- **A1**：多个编辑 + exec + submit 并行
- **A7**：两个 edit 调用

**成本**：~12 条消息，~1400 tokens

---

## 四、system-reminder 虚构场景（独立 fewshot）

以下行为无法在 bootstrap 中自然教学，如果需要覆盖，需要作为独立的 fewshot 场景（使用 `<system-reminder>` 创建虚拟语境）。

### A9: git commit 规范

```
<system-reminder>
你刚完成了一个 TypeScript 重构任务（将 formatDate 提取为独立模块）。
所有测试通过。现在需要提交代码。
工作目录有 3 个文件变更。
</system-reminder>
帮我提交一下。
```

assistant:
```
write(".temp/commit-msg.md", "refactor: extract formatDate into...")
exec('git add -A && git commit -F .temp/commit-msg.md && rm .temp/commit-msg.md')
submit(completed, "已提交...")
```

教学重点：commit message 写文件再 -F 引用，避免 shell 引号问题。

### A10: reminder 使用

这个行为不太适合 fewshot 教学。原因：

1. reminder 的价值在于**长任务中途**设置，fewshot 无法展现「经过多轮后想起来要设 reminder」的决策过程
2. 强行在短场景中使用 reminder 反而教学了错误模式（简单任务也设 reminder）
3. system prompt 中的一句话描述已经足够，模型对 reminder 的理解不依赖示例

**建议**：保留 system prompt 声明，不做 fewshot。

### A12: ask_user 使用

```
<system-reminder>
用户的 tsconfig.json 中 target 是 ES2020，但代码中大量使用了 ES2022 特性。
有两种修复方向，需要用户决定。
</system-reminder>
帮我解决一下编译报错。
```

assistant:
```
submit({
  type: "ask_user",
  question: "发现代码使用了 ES2022 特性但 target 是 ES2020，有两个方向：",
  options: [
    { choice: "升级 target 到 ES2022", affect: "需要确认部署环境支持" },
    { choice: "降级代码到 ES2020 兼容写法", affect: "需要修改 12 处 structuredClone 和 3 处 at()" }
  ]
})
```

教学重点：不确定时给出具体选项+影响分析，而非自己做决定。

---

## 五、综合评估

### 覆盖矩阵

| 行为 | 动态 bootstrap | 静态 fewshot (system-reminder) | system prompt 声明 |
|------|---------------|-------------------------------|-------------------|
| A1 并行调用 | ✓ Turn 2 | — | 可精简 |
| A2 脚本替代 shell | ✓ Turn 1 | — | 可精简 |
| A3 先读后改 | ✓ Turn 1→2 | — | 可精简 |
| A5 验证后 submit | ✓ Turn 2 | — | 可精简 |
| A6 环境感知 | ✓ Turn 1 | — | 可删除 |
| A7 write vs edit | ✓ Turn 2 | — | 可精简 |
| A9 git commit | — | ✓ 独立场景 | 可精简 |
| A10 reminder | — | — | 保留声明 |
| A11 错误诊断 | ✓ 方案B Turn 2→3 | 或独立场景 | 可精简 |
| A12 ask_user | — | ✓ 独立场景 | 可精简 |

### 推荐组合

**动态 bootstrap（方案 A，2-turn）+ 1 个静态场景（A9 git commit）**

- 覆盖 A1, A2, A3, A5, A6, A7 + 全部信息注入
- git commit 用一个短的 system-reminder 场景补充
- A10 (reminder) 保留 system prompt 声明
- A11 (错误诊断) 如果觉得重要，升级为方案 B
- A12 (ask_user) 如果觉得重要，加一个短的 system-reminder 场景

**对比当前方案**：

|  | 当前 | 推荐 |
|--|------|-----|
| 静态 fewshot | 2 场景, 22 条消息 | 1 场景 (git), ~6 条消息 |
| 动态 fewshot | 无 | 1 个 bootstrap, ~8 条消息 |
| 行为覆盖 | 3 个 (A1, A2, A5) | 7-8 个 |
| 信息注入 | system prompt 声明式 | 真实执行结果 |
| system 前缀稳定性 | 被 agents.md 污染 | 完全稳定 |

---

## 六、关于 A11 的取舍

A11（错误诊断）的独特之处：它是唯一一个「失败→恢复」模式的教学。

**支持用 3-turn 方案覆盖的理由**：
- 模型最常见的低质量行为就是遇错盲目重试或放弃
- 真实的类型错误 → 真实的诊断 → 真实的修复，比声明式描述强得多
- 只多 ~400 tokens

**反对的理由**：
- bootstrap 流程变得不那么「干净」—— 故意放一个有 bug 的文件略显做作
- 3 轮 turn 增加了启动时间（每轮需要 LLM 往返...等等，这是 fewshot，不需要 LLM 往返，是预构造的消息）

实际上没有 LLM 往返的问题——fewshot 是预构造的，3 轮和 2 轮的区别只是 history 中多几条消息。成本纯粹是 token 量。
