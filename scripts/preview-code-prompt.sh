#!/bin/sh
# 一键预览 apps/code 场景的完整文本流（同时渲染 Qwen 和 GLM 两个模板）
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
echo "==> Step 2a: Rendering with Qwen chat template..."
uv run scripts/render-chat-template.py \
  --template scripts/chat_template_qwen.jinja \
  --out .temp/rendered-prompt-qwen.md

echo ""
echo "==> Step 2b: Rendering with GLM chat template..."
uv run scripts/render-chat-template.py \
  --template scripts/chat_template_glm.jinja \
  --out .temp/rendered-prompt-glm.md

echo ""
echo "==> Step 2c: Rendering with Claude chat template (approximate)..."
uv run scripts/render-chat-template.py \
  --template scripts/chat_template_claude.jinja \
  --out .temp/rendered-prompt-claude.md

echo ""
echo "==> Done."
echo "  Qwen output:   .temp/rendered-prompt-qwen.md"
echo "  GLM  output:   .temp/rendered-prompt-glm.md"
echo "  Claude output:  .temp/rendered-prompt-claude.md"
