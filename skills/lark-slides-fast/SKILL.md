---
name: lark-slides-fast
version: 1.2.0
description: "Fast, minimal Lark Slides/PPT instructions for CodexMobile."
metadata:
  requires:
    bins: ["lark-cli"]
---

# Lark Slides Fast Skill

- Default identity: always add `--as user`.
- For PPT, use `lark-cli slides`; do not use docs commands.
- Create a simple PPT:
  `lark-cli slides +create --as user --title "<title>" --slides "<json-array-of-slide-xml>"`
- For more than 10 pages or complex content, first create the presentation, then add pages through `xml_presentation.slide.create`.
- Avoid duplicate PPT files: in one user task, run `slides +create` at most once for a given title. If creation partially fails or verification shows missing content, keep the returned `xml_presentation_id`, read it with `xml_presentations get`, then repair/append pages on that same PPT with `xml_presentation.slide.create` or `+replace-slide`. Do not start over with another `slides +create`.
- If `slides +create --slides` is likely to hit quoting/length/XML issues, switch to the safer two-step flow before creating: create one blank PPT, then append pages one by one. Do not retry by creating new PPT files.
- Verify after create:
  `lark-cli slides xml_presentations get --as user --params '{"xml_presentation_id":"<id>"}'`
- Prefer direct creation and one verification command. Do not repeatedly run help.
- For delete, overwrite, move, or bulk edits, ask the user first. Do not add `--yes`.
- Final reply: concise Chinese, only result/link/next step.
