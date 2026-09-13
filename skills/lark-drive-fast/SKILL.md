---
name: lark-drive-fast
version: 1.1.0
description: "Fast, minimal Lark Drive instructions for CodexMobile."
metadata:
  requires:
    bins: ["lark-cli"]
---

# Lark Drive Fast Skill

- Default identity: always add `--as user`.
- Use `lark-cli drive` for upload, download, folder creation, move, delete, rename, and import.
- Upload/download files with `drive +upload/+download`.
- Import Word/Markdown/TXT/HTML as online documents:
  `lark-cli drive +import --as user --type docx --file "<path>"`
- Import Excel/CSV as online spreadsheets:
  `lark-cli drive +import --as user --type sheet --file "<path>"`
- For delete, overwrite, move, or bulk edits, ask the user first. Do not add `--yes`.
- Never output App Secret, access token, or refresh token.
- Final reply: concise Chinese, only result/link/next step.
