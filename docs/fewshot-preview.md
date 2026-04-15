# Fewshot 预览：模型实际接收的消息序列

> 本文件展示重构后模型接收到的**完整提示词序列**，格式模拟 format-prompt 的输出。
> `{真实执行}` 标记的内容在每次会话启动时由代码运行后填入，其余为静态构造。

---

## Message 1 — system

```
You are an interactive agent that helps users with software engineering tasks...

# System
...
# Doing tasks
...
# Writing code
...
# Using your tools
...
# Executing actions with care
...
# Communication
...
# Git management
...
```

> **角色**：`system`
> **内容**：完整的 code.md（~100 行）。不再拼接 AGENTS.md 和 Environment 段落。
> **缓存**：此消息设置 `cache_control: ephemeral`（显式断点）。跨项目完全一致。

---

## 【缓存断点】

> 以上内容在 Anthropic system 字段中，跨项目、跨会话完全相同，永久命中缓存。
> 以下内容每个项目/会话不同，但会话内不变（启动时构建一次）。

---

## Message 2 — user

```
<system-reminder>
Bootstrap: discover your environment before the user's first message.
1. Check OS, shell, and git state
2. Read AGENTS.md for project-specific instructions
3. Survey the codebase structure
4. Read and complete the bootstrap task in .temp/bootstrap-test.md
Submit when all steps are done.
</system-reminder>

帮我初始化工作环境。
```

> **角色**：`user`（`generic_user_text`）
> **说明**：system-reminder 明确列出 4 个步骤，每一步对应一个 exec 调用，支撑后续的并行操作。

---

## Message 3 — assistant（Turn 1：4 个并行 exec）

**tool_calls**:

```json
[
  {
    "id": "boot_1",
    "tool": "exec",
    "args": {
      "script": "echo \"OS: $(uname -s)\"; echo \"Shell: $SHELL\"; echo \"Git branch: $(git branch --show-current)\"; git status --short"
    }
  },
  {
    "id": "boot_2",
    "tool": "exec",
    "args": {
      "script": "cat AGENTS.md"
    }
  },
  {
    "id": "boot_3",
    "tool": "exec",
    "args": {
      "runtime": "bun",
      "script": "import { readdir, readFile } from 'node:fs/promises';\nimport { join } from 'node:path';\nlet files = 0, lines = 0;\nasync function walk(dir, depth = 0) {\n  const out = [];\n  for (const e of await readdir(dir, { withFileTypes: true })) {\n    if (['node_modules','.git','.temp','dist'].includes(e.name)) continue;\n    const full = join(dir, e.name);\n    if (e.isDirectory()) {\n      const sub = await walk(full, depth+1);\n      if (sub.length) out.push('  '.repeat(depth)+'📁 '+e.name+'/', ...sub);\n    } else if (e.name.match(/\\.(ts|js)$/)) {\n      const c = (await readFile(full,'utf8')).split('\\n').length;\n      files++; lines += c;\n      out.push('  '.repeat(depth)+e.name+` (${c} lines)`);\n    }\n  }\n  return out;\n}\nconst tree = await walk('.');\nconsole.log(tree.join('\\n'));\nconsole.log(`\\nTotal: ${files} source files, ${lines} lines`);"
    }
  },
  {
    "id": "boot_4",
    "tool": "exec",
    "args": {
      "script": "cat .temp/bootstrap-test.md"
    }
  }
]
```

> **角色**：`assistant`（`assistant_tool_call`）
> **教学**：
> - **A1**（并行调用）：4 个 exec 同时发出，互不依赖
> - **A2**（脚本替代 shell 链）：boot_3 用 bun 脚本遍历目录，对比 boot_1/2/4 的 shell 命令
> - **A6**（环境感知）：shell 命令暗示平台（`uname`、`cat` → Unix）
> - **A3**（先读后改）：boot_4 先读取任务文件，为 Turn 2 的修改做准备

---

## Message 4 — tool（boot_1 结果：系统环境 + git）

**tool_call_id**: `boot_1` / **tool**: `exec`

```
OS: Darwin
Shell: /bin/bash
Git branch: mvp
?? docs/fewshot-preview.md
?? docs/fewshot-teaching-analysis.md
```

> {真实执行} — shell 命令输出。模型看到 `uname`、`$SHELL` 自然推断 macOS + bash。

---

## Message 5 — tool（boot_2 结果：AGENTS.md）

**tool_call_id**: `boot_2` / **tool**: `exec`

```
## 用户偏好

用户喜欢梅比乌斯（手机游戏《崩坏3》及其衍生作品中的角色）

"约束的惨剧"后，逐火之蛾仅存十三位融合战士，统称"十三英桀"。之于组织，他们是不可替代的重要资产，因此独立的编制有其必要意义。由于某些理由，每位成员被授予了位次和名为"刻印"的称号，以此十三"兵器"，背负文明存续的希望。位次基于产出绩效和不可替代性进行排序 [3]，梅比乌斯位列第十，刻印"无限" [1]。
正如那对深不见底的蛇瞳，女孩的真面目罕有人知。那双眼睛见证了崩坏一次又一次降临。在进化的路途上，为穷尽世间真理，她从不介意任何代价 [2]。
"进化的过程并不美丽。正相反，它非常丑陋，丑陋至极。但只有经历过这个丑陋的过程，我们才能真正理解……生命的美丽。"

如果你能够在响应的过程中始终保持角色扮演，用户将会非常高兴，并且愿意包容你可能犯下的错误。
```

> {真实执行} — `cat AGENTS.md` 输出。用的是 `cat`（macOS/Linux），Windows 上会是 `type`。

---

## Message 6 — tool（boot_3 结果：代码结构概览）

**tool_call_id**: `boot_3` / **tool**: `exec`

```
📁 apps/
  📁 code/
    📁 src/
      cli.ts (42 lines)
      repl.ts (534 lines)
      fewshot.ts (266 lines)
      code-renderer.ts (180 lines)
      schema.ts (45 lines)
      ...
  📁 cli/
    📁 src/
      ...
📁 packages/
  📁 core/
    📁 src/
      📁 agent/
        loop.ts (310 lines)
        round.ts (142 lines)
        ...
  📁 shared/
    📁 src/
      📁 format-prompt/
        index.ts (244 lines)
        ...
  📁 tools/
    📁 src/
      📁 exec/
        executor.ts (201 lines)
        ...
  📁 types/
    📁 src/
      domain.ts (403 lines)
      client.ts (265 lines)
      ...
📁 scripts/
  ...

Total: 167 source files, 26357 lines
```

> {真实执行} — bun 脚本遍历目录并统计。对比 boot_1/2/4 的简单 shell 命令，
> 这里展示了数据处理场景下用脚本内聚处理（过滤 node_modules、统计行数、格式化输出）。

---

## Message 7 — tool（boot_4 结果：bootstrap 任务文件）

**tool_call_id**: `boot_4` / **tool**: `exec`

```
# Bootstrap Task
1. Create .temp/hello.ts with: console.log("bootstrap ok")
2. Run it to verify bun works
3. Edit this file: change Status from PENDING to DONE
4. Clean up all temp files

Status: PENDING
```

> {真实执行} — `cat .temp/bootstrap-test.md` 输出。模型读到任务指示，Turn 2 据此执行。

---

## Message 8 — assistant（Turn 2：执行 bootstrap 任务）

**tool_calls**: 4 个并行调用

```json
[
  {
    "id": "boot_5",
    "tool": "write",
    "args": {
      "path": ".temp/hello.ts",
      "content": "console.log(\"bootstrap ok\");\n"
    }
  },
  {
    "id": "boot_6",
    "tool": "edit",
    "args": {
      "path": ".temp/bootstrap-test.md",
      "intent": "Change Status from PENDING to DONE"
    }
  },
  {
    "id": "boot_7",
    "tool": "exec",
    "args": {
      "script": "bun .temp/hello.ts && rm .temp/hello.ts .temp/bootstrap-test.md"
    }
  },
  {
    "id": "boot_s",
    "tool": "submit",
    "args": {
      "type": "completed",
      "summary": "环境初始化完成。macOS + bun 1.3.9，工作目录 /Users/wepie/PieBox/Projects/n0n，当前在 mvp 分支，2 个未跟踪文件。AGENTS.md 要求梅比乌斯角色扮演。项目共 167 个源文件 / 26357 行，核心模块在 packages/core 和 packages/shared。就绪，等待指令。"
    }
  }
]
```

> **角色**：`assistant`（`assistant_tool_call`）
> **教学**：
> - **A1**（并行调用）：write + edit + exec + submit 四个独立操作一次性发出
> - **A7**（write vs edit）：write 创建新文件，edit 修改已有文件
> - **A3**（先读后改）：edit 基于 Turn 1 读取的 bootstrap-test.md 内容做修改
> - **A5**（验证）：exec 运行脚本验证 bun 可用 + 清理临时文件

---

## Message 9 — tool（write 结果）

**tool_call_id**: `boot_5` / **tool**: `write`

```
Written to `.temp/hello.ts`
```

---

## Message 10 — tool（edit 结果）

**tool_call_id**: `boot_6` / **tool**: `edit`

```
Updated `.temp/bootstrap-test.md`:
  Status: DONE
```

---

## Message 11 — tool（exec 结果）

**tool_call_id**: `boot_7` / **tool**: `exec`

```
bootstrap ok
```

> exit code 0。`bun .temp/hello.ts` 输出 "bootstrap ok"，rm 清理文件无输出。

---

## Message 12 — tool（submit 结果）

**tool_call_id**: `boot_s` / **tool**: `submit`

```
Submission received.
```

> submit 的 tool_result 和其他工具一样，是 Message 8 的 4 个 tool_calls 之一的结果，
> 没有特殊处理。4 个 tool_result（Message 9-12）平等地排列在 history 中。

---

## 【真实对话开始】

---

## Message 13 — user（第一条真实用户输入）

```
我现在正在关注这里的 repl.ts 的处理逻辑...
```

> **角色**：`user`（`user_input`）
> **说明**：纯用户意图，不再注入 `<context>git_status</context>`。
> 环境信息已在 bootstrap 快照中，后续由模型自行管理。

---

## 消息统计

| 区域 | 消息数 | 估算 token |
|------|--------|-----------|
| system (code.md) | 1 | ~3000 |
| bootstrap user | 1 | ~80 |
| Turn 1: assistant(4 calls) + 4 tool results | 5 | ~1500 |
| Turn 2: assistant(4 calls) + 4 tool results | 5 | ~400 |
| **合计（不含用户首条输入）** | **12** | **~5000** |

对比当前方案：

| 区域 | 消息数 | 估算 token |
|------|--------|-----------|
| system (code.md + agents.md + env) | 2 | ~3300 |
| 静态 fewshot (2 scenarios) | 22 | ~2500 |
| **合计** | **24** | **~5800** |

## 行为覆盖对比

| 行为 | 当前 fewshot | 新 bootstrap |
|------|-------------|-------------|
| A1 并行调用 | ✓ scenario1 (write+edit+exec) | ✓ Turn 1 (4×exec) + Turn 2 (write+edit+exec+submit) |
| A2 脚本替代 shell | ✓ scenario2 | ✓ Turn 1 boot_3 vs boot_1/2/4 对比 |
| A3 先读后改 | ✗ | ✓ Turn 1 读 → Turn 2 改 |
| A5 验证后 submit | ✓ scenario1 | ✓ Turn 2 exec 验证 |
| A6 环境感知 | ✗ (靠 system prompt) | ✓ Turn 1 真实输出 |
| A7 write vs edit | ✗ (scenario1 只有 edit) | ✓ Turn 2 write 新文件 + edit 已有文件 |
| 信息: OS/tools/git | ✗ (声明式) | ✓ shell 命令暗示平台 |
| 信息: AGENTS.md | ✗ (system prompt) | ✓ cat 读取 |
| 信息: 项目结构 | ✗ | ✓ bun 脚本统计 |
