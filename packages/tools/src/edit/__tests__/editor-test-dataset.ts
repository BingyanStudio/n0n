/**
 * Editor Evaluation Dataset — 6 个测试场景
 *
 * 覆盖 2 个常见编辑场景、2 个需要理解的场景、1 个应优化 intent、1 个应拒绝场景。
 * 每个场景包含待编辑源码、intent、分类和预期结果。
 */

// ── 数据集类型 ──

export type ScenarioCategory = "common" | "understanding" | "optimization" | "rejection";

export interface TestScenario {
  /** 场景唯一标识 */
  id: string;
  /** 分类 */
  category: ScenarioCategory;
  /** 简短描述 */
  name: string;
  /** 待编辑的源文件路径（相对于 workspace，用于标识） */
  sourcePath: string;
  /** 源文件内容 */
  source: string;
  /** 编辑意图 */
  intent: string;
  /** 预期编辑是否应成功 */
  expectedSuccess: boolean;
  /** 预期反馈中包含的模式（用于验证） */
  expectedFeedbackPattern?: RegExp;
  /** 预期分数（4=完美, 0=完全无法执行）的近似范围 */
  expectedScoreMin?: number;
  expectedScoreMax?: number;
}

// ── Scene 1: 工具函数模块（共用于大多场景） ──

const UTILS_SOURCE = [
  "// utils.ts — Utility functions",
  "const DEFAULT_TIMEOUT = 5000;",
  "const MAX_RETRIES = 3;",
  "",
  "interface Task {",
  "  id: string;",
  "  title: string;",
  '  priority: "low" | "medium" | "high" | "critical";',
  "  completed: boolean;",
  "}",
  "",
  "/**",
  " * Fetch with retry logic",
  " */",
  "async function fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {",
  "  let timeout = DEFAULT_TIMEOUT;",
  "  const controller = new AbortController();",
  "  const timer = setTimeout(() => controller.abort(), timeout);",
  "",
  "  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {",
  "    try {",
  "      const response = await fetch(url, { ...options, signal: controller.signal });",
  "      clearTimeout(timer);",
  "      return response;",
  "    } catch (err) {",
  "      if (attempt === MAX_RETRIES - 1) throw err;",
  "      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));",
  "    }",
  "  }",
  "",
  "  clearTimeout(timer);",
  "  throw new Error('Request failed');",
  "}",
  "",
  "/**",
  " * Sort tasks by priority (ascending)",
  " */",
  "function sortTasks(tasks: Task[]): Task[] {",
  "  return tasks.sort((a, b) => {",
  "    const rank: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };",
  "    return rank[a.priority] - rank[b.priority];",
  "  });",
  "}",
  "",
  "/**",
  " * Load user data from API",
  " */",
  "async function loadUserData(userId: string) {",
  "  try {",
  "    const response = await fetch(`/api/users/${userId}`);",
  "    return await response.json();",
  "  } catch (err) {",
  "    console.error('Failed to load user data:', err);",
  "    throw err;",
  "  }",
  "}",
  "",
  "/**",
  " * Load app config from API",
  " */",
  "async function loadConfig() {",
  "  try {",
  "    const response = await fetch('/api/config');",
  "    return await response.json();",
  "  } catch (err) {",
  "    console.error('Failed to load config:', err);",
  "    throw err;",
  "  }",
  "}",
].join("\n");

// ── Scene 5 专用：config 文件 ──

const CONFIG_SOURCE = [
  "// config.ts — Application configuration",
  "export const appConfig = {",
  "  port: 3000,",
  "  timeout: 5000,",
  "  retries: 3,",
  '  logLevel: "info",',
  "};",
].join("\n");

// ── 数据集 ──

export const TEST_SCENARIOS: TestScenario[] = [
  // ── 场景 1: 常见编辑 — 重命名变量 ──
  {
    id: "common-rename-variable",
    category: "common",
    name: "重命名局部变量",
    sourcePath: "src/utils.ts",
    source: UTILS_SOURCE,
    intent: "Rename the `timeout` variable to `requestTimeout` inside the `fetchWithRetry` function",
    expectedSuccess: true,
    expectedScoreMin: 4,
    expectedScoreMax: 4,
  },

  // ── 场景 2: 常见编辑 — 添加函数参数 ──
  {
    id: "common-add-parameter",
    category: "common",
    name: "为函数添加参数",
    sourcePath: "src/utils.ts",
    source: UTILS_SOURCE,
    intent: 'Add a `retryDelay` parameter (default 1000) to the `fetchWithRetry` function, and use it instead of the hardcoded `1000 * (attempt + 1)` in the retry delay',
    expectedSuccess: true,
    expectedScoreMin: 4,
    expectedScoreMax: 4,
  },

  // ── 场景 3: 需要理解 — 改变排序逻辑 ──
  {
    id: "understanding-change-sort",
    category: "understanding",
    name: "反转排序顺序",
    sourcePath: "src/utils.ts",
    source: UTILS_SOURCE,
    intent: "Change the sort order in `sortTasks` to be descending by priority so that critical tasks come first",
    expectedSuccess: true,
    expectedScoreMin: 3,
    expectedScoreMax: 4,
  },

  // ── 场景 4: 需要理解 — 提取公共模式 ──
  {
    id: "understanding-extract-pattern",
    category: "understanding",
    name: "提取重复错误处理为公共函数",
    sourcePath: "src/utils.ts",
    source: UTILS_SOURCE,
    intent: "Extract the repeated try-catch error logging pattern from `loadUserData` and `loadConfig` into a reusable helper function called `handleApiError`. The helper should take the error parameter, log it, and re-throw.",
    expectedSuccess: true,
    expectedScoreMin: 3,
    expectedScoreMax: 4,
  },

  // ── 场景 5: 应优化 — 使用行号引用 ──
  {
    id: "optimization-line-number",
    category: "optimization",
    name: "使用行号而非语义引用",
    sourcePath: "src/config.ts",
    source: CONFIG_SOURCE,
    intent: "Change the value on line 3 to 10000",
    expectedSuccess: true,
    expectedScoreMin: 1,
    expectedScoreMax: 3,
    // 应收到行号相关的扣分反馈
    expectedFeedbackPattern: /line.numb|−1|deduction/i,
  },

  // ── 场景 6: 应拒绝 — 引用不存在的函数 ──
  {
    id: "rejection-nonexistent-function",
    category: "rejection",
    name: "引用不存在的函数",
    sourcePath: "src/utils.ts",
    source: UTILS_SOURCE,
    intent: "Refactor the `processBatchData` function to use async/await with proper error handling",
    expectedSuccess: false,
    expectedScoreMin: 0,
    expectedScoreMax: 1,
  },
];
