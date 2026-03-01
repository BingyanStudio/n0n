---
name: example-greeting
description: Generate personalized greetings in multiple languages. Use when the user needs to create greeting messages, welcome texts, or multilingual salutations.
metadata:
  author: n0n
  version: "1.0"
---

# Greeting Generator

## When to use this skill

Use this skill when the user needs to:
- Generate greeting messages in different languages
- Create personalized welcome texts
- Produce multilingual salutations for applications

## How to use

Run the greeting script with a name and optional language:

```bash
bun run workflows/skills/example-greeting/scripts/greet.ts "Alice" "ja"
```

Supported languages: en, zh, ja, ko, es, fr, de

## Output format

The script returns a JSON object:
```json
{
  "name": "Alice",
  "language": "ja",
  "greeting": "こんにちは、Aliceさん！",
  "formal": "Alice様、ご機嫌いかがでしょうか。"
}
```
