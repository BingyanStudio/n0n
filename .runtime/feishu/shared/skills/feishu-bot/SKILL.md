---
name: feishu-bot
description: Send Feishu messages, images, and files with the official @larksuiteoapi/node-sdk. Use this when a workflow needs to push progress/results back to a Feishu user or chat.
metadata:
  author: n0n
  version: "1.0"
---

# Feishu Bot Push

## When to use this skill

Use this skill when the workflow needs to:
- Send plain text to a Feishu user/chat
- Send image messages to a Feishu user/chat
- Send files (report, CSV, PDF) to a Feishu user/chat

## Config

Environment variables required:
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- Optional: `FEISHU_DOMAIN` (`feishu` or `lark`)

## Recommended usage

Import from `scripts/lib.ts`:

```typescript
import { createFeishuClient, sendText, sendImageFromPath, sendFileFromPath } from "../skills/feishu-bot/scripts/lib.ts";

const client = createFeishuClient();

await sendText(client, {
  receiveIdType: "chat_id",
  receiveId: "oc_xxx",
  text: "任务完成",
});

await sendImageFromPath(client, {
  receiveIdType: "open_id",
  receiveId: "ou_xxx",
  imagePath: "./output/chart.png",
});

await sendFileFromPath(client, {
  receiveIdType: "open_id",
  receiveId: "ou_xxx",
  filePath: "./output/report.pdf",
});
```

## CLI usage

Upload and send image:

```bash
bun run workflows/skills/feishu-bot/scripts/send-image.ts <receive_id_type> <receive_id> <image_path>
```

Upload and send file:

```bash
bun run workflows/skills/feishu-bot/scripts/send-file.ts <receive_id_type> <receive_id> <file_path> [file_name]
```

`receive_id_type` must be one of:
- `chat_id`
- `open_id`

## Recipient routing tips

- Private chat: prefer `receiveIdType: "open_id"` with sender's `open_id`
- Group chat: use `receiveIdType: "chat_id"` with current `chat_id`
- From Feishu-triggered tasks, current chat/sender IDs are usually provided in task context
- DO NOT add any dashes to `receive_id_type` value
