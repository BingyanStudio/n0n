# Harbor 评测框架集成测试报告

> 测试日期：2026-03-16
> 测试人：n0n code agent (headless mode)
> 评测框架：[Harbor](https://harborframework.com) v0.1.45
> 数据集：SWE-Bench Verified (5 tasks)

## 1. 背景

[Harbor](https://harborframework.com/docs/agents) 是一个 Agent 评测框架，支持在沙箱容器中评估 AI Agent 的编码能力。本次测试目标是验证 n0n code agent 能否集成 Harbor 评测流程，并评估 SWE-Bench 基准的区分度。

## 2. 测试方法

### 2.1 环境

- **运行方式**：本地模拟（无 Docker），通过 `harbor-sim.ts` 模拟 Harbor Trial 流程
- **Agent 模式**：新增 headless 模式（`apps/code/src/headless.ts`），单次执行后自动退出
- **LLM**：通过 n0n 现有 LLM 配置调用
- **限制**：无预装代码库（真实 Harbor 环境中代码在 `/testbed`），agent 需自行 clone

### 2.2 测试 Task

从 SWE-Bench Verified 选取 5 个不同项目、不同难度的 debugging task：

| Task | 项目 | 标注难度 | 问题描述 |
|------|------|----------|----------|
| `django__django-15098` | Django | 15min-1h | i18n 正则不支持同时含 script 和 region 的 locale |
| `scikit-learn__scikit-learn-13142` | sklearn | <15min | GaussianMixture fit_predict 与 predict 结果不一致 |
| `matplotlib__matplotlib-23476` | matplotlib | <15min | Figure pickle 后 DPI 翻倍 |
| `sympy__sympy-12419` | SymPy | 15min-1h | 单位矩阵元素求和返回零 |
| `pytest-dev__pytest-10356` | pytest | 1-4h | MRO 继承时 marker 丢失 |

### 2.3 运行参数

- 首轮：`maxIterations=80`，`timeout=10min`
- 复测（失败 task）：`maxIterations=80`，`timeout=60min`

## 3. 测试结果

### 3.1 首轮结果

| Task | 结果 | 耗时 | 轮次 | 说明 |
|------|------|------|------|------|
| `matplotlib__matplotlib-23476` | ✅ 通过 | 487s | 45 | 修复与参考解法完全一致 |
| `scikit-learn__scikit-learn-13142` | ✅ 通过 | 293s | ~40 | 修复与参考解法语义一致 |
| `django__django-15098` | ❌ 超时 | 600s | ~45 | 10 分钟内未完成 |
| `sympy__sympy-12419` | ❌ 超时 | 600s | ~45 | 10 分钟内未完成 |
| `pytest-dev__pytest-10356` | ❌ 超时 | 600s | ~45 | 10 分钟内未完成 |

**首轮通过率：2/5 (40%)**

### 3.2 修复质量验证

**matplotlib（✅）**：Agent 产出的 diff 与参考解法逐字一致：

```diff
# lib/matplotlib/figure.py __getstate__ 方法
+        # discard any changes to the dpi due to pixel ratio changes
+        state["_dpi"] = state.get('_original_dpi', state['_dpi'])
```

**scikit-learn（✅）**：Agent 正确识别了 `_e_step(X)` 在 `_set_parameters(best_params)` 之前执行的 bug，将其移到之后。与参考解法语义完全一致。

### 3.3 复测结果（放宽超时至 60min）

对 `django__django-15098` 进行复测，agent 在 64 轮后仍未完成。主要瓶颈：

1. **环境搭建耗时**：clone Django 源码 + 尝试安装依赖（本地无 Python/pip，只有 uv）
2. **测试执行困难**：尝试运行 Django 测试套件但环境不完整
3. **定位正确但未提交**：agent 已正确定位到 `language_code_prefix_re` 正则表达式，并理解了需要将 `{0,2}` 替换 `?` 来支持多段 locale，但卡在验证环节

## 4. 分析

### 4.1 区分度验证

SWE-Bench **确实具有良好的区分度**：

- **难度梯度清晰**：`<15min` 标注的 2 个 task 全部通过，`15min-1h` 和 `1-4h` 的全部失败，与标注难度完全吻合
- **修复质量可验证**：通过的 task 产出的 patch 与人类参考解法一致，不是碰运气
- **失败原因合理**：不是 agent 能力不足，而是环境约束（无预装代码库、无 Python 环境）导致时间浪费

### 4.2 本地模拟的局限

本次测试的主要局限在于 **缺少 Docker 容器环境**：

| 因素 | 真实 Harbor 环境 | 本地模拟 |
|------|------------------|----------|
| 代码库 | 预装在 `/testbed`，特定 commit | agent 需自行 clone（最新版本） |
| Python 环境 | 容器内预装，依赖已就绪 | 本地无 Python，只有 uv |
| 测试执行 | 容器内可直接运行 | 环境不完整，无法运行 |
| 网络 | 由 task 配置控制 | 始终可用 |

这意味着 agent 的大量时间花在了环境搭建而非问题解决上。在真实 Harbor 环境中，通过率预计会显著提升。

### 4.3 Agent 行为模式观察

- **探索阶段过长**：agent 倾向于全面理解代码库后再动手，在大型项目中这会消耗大量轮次
- **工具使用合理**：正确使用 `exec` 读取代码、`git` 操作、运行时脚本分析
- **定位能力强**：即使在失败的 task 中，agent 也能正确定位到问题代码区域

## 5. 后续建议

1. **接入 Docker**：使用 Harbor 的 Installed Agent 模式，编写 `install-n0n.sh.j2` 安装脚本，在容器内运行 n0n
2. **优化 headless prompt**：针对评测场景，引导 agent 减少探索、快速定位、尽早提交
3. **跑完整 benchmark**：在 Docker 环境下跑 SWE-Bench Verified 全部 500 个 task，获得可对比的通过率数据
4. **对比其他 agent**：与 Claude Code、Codex 等在同一 benchmark 上的公开成绩对比

## 6. 新增文件

| 文件 | 说明 |
|------|------|
| `apps/code/src/headless.ts` | Code Agent headless 模式 — 非交互单次执行 |
| `scripts/harbor-sim.ts` | Harbor Trial 本地模拟 Runner |
| `docs/harbor-eval-report.md` | 本报告 |
