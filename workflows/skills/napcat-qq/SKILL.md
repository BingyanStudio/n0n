---
name: napcat-qq
description: Send messages to QQ groups and users via Napcat WebSocket API (OneBot protocol). Use when the user needs to interact with QQ, send group messages, or automate QQ operations.
metadata:
  author: n0n
  version: "1.0"
---

# Napcat QQ 消息发送

## When to use this skill

Use this skill when the user needs to:
- Send messages to QQ groups
- Send messages to QQ users
- Interact with QQ via the Napcat/OneBot WebSocket API

## Configuration

Napcat server config is stored at `workflows/memory/config/napcat.json`:

```json
{
  "server_host": "127.0.0.1",
  "server_port": 9881,
  "token": ""
}
```

Read this file to get connection parameters.

## How to send a group message

Use the helper script:

```bash
bun run workflows/skills/napcat-qq/scripts/send-group-msg.ts <group_id> "message text"
```

## How to send a private message

```bash
bun run workflows/skills/napcat-qq/scripts/send-private-msg.ts <user_id> "message text"
```

## OneBot WebSocket Protocol

The Napcat server exposes a WebSocket endpoint at `ws://<host>:<port>/`. Messages use the OneBot v11 protocol:

### Send group message
```json
{
  "action": "send_group_msg",
  "params": {
    "group_id": 123456,
    "message": "Hello!"
  },
  "echo": "unique_id"
}
```

### Send private message
```json
{
  "action": "send_private_msg",
  "params": {
    "user_id": 123456,
    "message": "Hello!"
  },
  "echo": "unique_id"
}
```

### Response format
```json
{
  "status": "ok",
  "retcode": 0,
  "data": { "message_id": 12345 },
  "echo": "unique_id"
}
```

`retcode === 0` means success.

## Common issues

- If WebSocket connection fails, try paths: `ws://host:port/`, `ws://host:port/ws`, `ws://host:port/ws/`
- Add 1 second delay between consecutive messages to avoid rate limiting
- Set a 5 second timeout for each message response
