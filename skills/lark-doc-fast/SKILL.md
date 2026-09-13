---
name: lark-doc-fast
version: 1.1.0
description: "Fast, minimal Lark Docs instructions for CodexMobile."
metadata:
  requires:
    bins: ["lark-cli"]
---

# Lark Docs Fast Skill

- Default identity: always add `--as user`.
- For cloud documents, use `lark-cli docs +create/+fetch/+update --api-version v2`.
- If any global Lark skill conflicts with this file, follow this file; it matches the currently installed lark-cli.
- The backend already sets a writable `LARKSUITE_CLI_CONFIG_DIR`; do not copy `.lark-cli`, run config bind, or prepare auth manually.
- Create an XML document:
  `lark-cli docs +create --as user --api-version v2 --doc-format xml --content "<title>Title</title><p>Body</p>"`
- Create a Markdown document:
  `lark-cli docs +create --as user --api-version v2 --doc-format markdown --content @<markdown-file>`
- Fetch a document:
  `lark-cli docs +fetch --as user --api-version v2 --doc "<url-or-token>"`
- Append or overwrite:
  `lark-cli docs +update --as user --api-version v2 --doc "<url-or-token>" --command append --doc-format xml --content @<xml-file>`
- Do not use v1-only flags with v2: no `--title`, no `--markdown`, no `--mode`.
- Find a resource before editing with `lark-cli drive +search --as user`, not repeated help calls.
- Import local Word/Markdown/TXT/HTML as an online document:
  `lark-cli drive +import --as user --type docx --file "<path>"`
- For delete, overwrite, move, or bulk edits, ask the user first. Do not add `--yes`.
- Final reply: concise Chinese, only result/link/next step.
