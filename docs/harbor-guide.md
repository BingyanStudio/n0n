# Harbor 评测指南

使用 [Harbor](https://harborframework.com) 框架评测 n0n code agent 的编码能力。

## 前置条件

- Docker（本地运行）或 Daytona/Modal 账号（云端运行）
- Python 3.12+，推荐用 [uv](https://docs.astral.sh/uv/) 管理
- Harbor CLI：`uv tool install harbor`

## 快速开始

### 1. 安装 Harbor

```bash
uv tool install harbor
harbor --help
```

### 2. 编写 Agent 适配器

创建 Python 文件实现 `BaseInstalledAgent` 接口：

```python
# n0n_agent.py
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext


class N0nAgent(BaseInstalledAgent):
    """n0n code agent — Harbor Installed Agent 适配器"""

    @staticmethod
    def name() -> str:
        return "n0n"

    def get_version_command(self) -> str | None:
        return "n0n --version"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-n0n.sh.j2"

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        escaped = shlex.quote(instruction)

        env = {
            "LLM_BASE_URL": os.environ.get("LLM_BASE_URL", ""),
            "LLM_API_KEY": os.environ.get("LLM_API_KEY", ""),
            "LLM_MODEL": os.environ.get("LLM_MODEL", ""),
        }

        return [
            ExecInput(
                command=f"n0n --workspace /app -- {escaped}",
                env=env,
                timeout_sec=900,
            ),
        ]

    def populate_context_post_run(self, context: AgentContext) -> None:
        # TODO: 解析 agent 日志，填充 token 统计
        pass
```

### 3. 编写安装脚本

```bash
# install-n0n.sh.j2
#!/bin/bash
set -euo pipefail

# 安装 bun
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# 安装 n0n
bun install -g n0n

n0n --version
```

### 4. 运行评测

```bash
# 单个 task
harbor run -p path/to/task \
  --agent-import-path n0n_agent:N0nAgent \
  -m "deepseek/deepseek-v3.2"

# 注册数据集（如 SWE-Bench Verified）
harbor run -d "swebench-verified@1.0" \
  --agent-import-path n0n_agent:N0nAgent \
  -m "deepseek/deepseek-v3.2" \
  --n-concurrent 4

# 云端并行（Daytona）
harbor run -d "swebench-verified@1.0" \
  --agent-import-path n0n_agent:N0nAgent \
  -m "deepseek/deepseek-v3.2" \
  --env daytona \
  --n-concurrent 32
```

### 5. 查看结果

评测结果保存在 `harbor_results/` 目录，每个 trial 包含：

```
trial_dir/
  config.json       # 运行配置
  results.json      # 结果（reward、耗时、异常）
  agent/             # agent 日志
  verifier/          # 验证结果（reward.txt）
```

## Headless 模式

`apps/code/src/headless.ts` 提供了非交互执行入口，供评测场景使用：

```typescript
import { runHeadless } from "./headless.ts";

const result = await runHeadless({
  instruction: "Fix the bug in src/utils.ts",
  paths: { workspace: "/app", temp: "/tmp/n0n" },
  maxIterations: 80,
  timeoutMs: 600_000,
});

// result: { success, result, report, rounds, durationMs, error }
```

关键行为：
- **自主执行**：`need_info` 自动回复，不等待用户
- **超时控制**：可配置 `timeoutMs`
- **结构化输出**：返回 `HeadlessResult`

## 可用数据集

```bash
harbor datasets list
```

推荐评测数据集：

| 数据集 | 任务数 | 说明 |
|--------|--------|------|
| `swebench-verified@1.0` | 500 | 真实开源项目 bug 修复 |
| `terminal-bench@2.0` | 89 | 终端环境综合任务 |
| `aider-polyglot@1.0` | 225 | 多语言编码练习 |

## 参考

- [Harbor 文档](https://harborframework.com/docs)
- [Harbor Agents 集成指南](https://harborframework.com/docs/agents)
- [SWE-Bench](https://www.swebench.com/)
- [评测报告](./harbor-eval-report.md)
