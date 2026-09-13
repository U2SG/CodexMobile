---
name: lark-sheets-fast
version: 1.1.0
description: "Fast, minimal Lark Sheets instructions for CodexMobile."
metadata:
  requires:
    bins: ["lark-cli"]
---

# Lark Sheets Fast Skill

- Default identity: always add `--as user`.
- For spreadsheets, use `lark-cli sheets`.
- Create a spreadsheet:
  `lark-cli sheets +create --as user --title "<title>" --headers '["A","B"]' --data '[["x","y"]]'`
- Read/write/append/find/export with `sheets +read/+write/+append/+find/+export --as user`.
- Import local Excel/CSV as an online spreadsheet:
  `lark-cli drive +import --as user --type sheet --file "<path>"`
- Write formulas as objects, for example `{"type":"formula","text":"=SUM(A1:A10)"}`.
- For delete, overwrite, clear, move, or bulk edits, ask the user first. Do not add `--yes`.
- Final reply: concise Chinese, only result/link/next step.
