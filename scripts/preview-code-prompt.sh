#!/bin/sh
# 一键预览 apps/code 场景的完整 Qwen 文本流
#
# 用法：
#   sh scripts/preview-code-prompt.sh                          # 使用默认用户消息
#   sh scripts/preview-code-prompt.sh --user "修复登录 bug"     # 自定义用户消息

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo "==> Step 1: Building request JSON..."
bun run scripts/build-code-request.ts "$@"

echo ""
echo "==> Step 2: Rendering with Qwen chat template..."
uv run scripts/render-chat-template.py

echo ""
echo "==> Done. Output: .temp/rendered-prompt.txt"
