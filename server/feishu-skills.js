import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const SKILL_FILES = {
  docs: path.join(ROOT_DIR, 'skills', 'lark-doc-fast', 'SKILL.md'),
  slides: path.join(ROOT_DIR, 'skills', 'lark-slides-fast', 'SKILL.md'),
  sheets: path.join(ROOT_DIR, 'skills', 'lark-sheets-fast', 'SKILL.md'),
  drive: path.join(ROOT_DIR, 'skills', 'lark-drive-fast', 'SKILL.md')
};

const SKILL_SUMMARIES = {
  docs: [
    'Lark Docs fast path:',
    '- Use `lark-cli docs +create/+fetch/+update --as user --api-version v2`.',
    '- Create XML: `lark-cli docs +create --as user --api-version v2 --doc-format xml --content "<title>Title</title><p>Body</p>"`.',
    '- Create Markdown: `lark-cli docs +create --as user --api-version v2 --doc-format markdown --content @<file>`.',
    '- Fetch: `lark-cli docs +fetch --as user --api-version v2 --doc "<url-or-token>"`.',
    '- Update: `lark-cli docs +update --as user --api-version v2 --doc "<url-or-token>" --command append --doc-format xml --content @<file>`.',
    '- Do not use v1-only flags with v2: no `--title`, no `--markdown`, no `--mode`.'
  ].join('\n'),
  slides: [
    'Lark Slides fast path:',
    '- Use `lark-cli slides` for PPT, not docs.',
    '- Create simple PPT: `lark-cli slides +create --as user --title "<title>" --slides "<json-array-of-slide-xml>"`.',
    '- In one user task, run `slides +create` at most once per title. If it partially fails, keep the returned `xml_presentation_id` and repair/append pages on that same PPT; do not create another PPT.',
    '- For complex XML, prefer the safer two-step flow before creating: one blank PPT, then `xml_presentation.slide.create` page by page.',
    '- Verify after create with `lark-cli slides xml_presentations get --as user --params ...`.'
  ].join('\n'),
  sheets: [
    'Lark Sheets fast path:',
    '- Use `lark-cli sheets` for spreadsheets.',
    '- Create: `lark-cli sheets +create --as user --title "<title>" --headers \'["A","B"]\' --data \'[["x","y"]]\'`.',
    '- Read/write/append/find/export with `sheets +read/+write/+append/+find/+export --as user`.',
    '- Import local Excel/CSV with `lark-cli drive +import --as user --type sheet --file "<path>"`.'
  ].join('\n'),
  drive: [
    'Lark Drive fast path:',
    '- Use `lark-cli drive` for upload, download, folder, move, delete, rename, and import.',
    '- Import Word/Markdown/TXT/HTML as docs with `drive +import --as user --type docx --file "<path>"`.',
    '- Import Excel/CSV as sheets with `drive +import --as user --type sheet --file "<path>"`.'
  ].join('\n')
};

const skillBodyCache = new Map();

function normalizeMessage(message) {
  return String(message || '').toLowerCase();
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function stripFrontMatter(text) {
  const value = String(text || '').trim();
  if (!value.startsWith('---')) {
    return value;
  }
  const endIndex = value.indexOf('\n---', 3);
  if (endIndex < 0) {
    return value;
  }
  return value.slice(endIndex + 4).trim();
}

async function readSkillBody(key) {
  if (skillBodyCache.has(key)) {
    return skillBodyCache.get(key);
  }
  const fallback = SKILL_SUMMARIES[key] || '';
  const skillPath = SKILL_FILES[key];
  if (!skillPath) {
    return fallback;
  }
  try {
    const raw = await fs.readFile(skillPath, 'utf8');
    const body = stripFrontMatter(raw);
    const value = body || fallback;
    skillBodyCache.set(key, value);
    return value;
  } catch {
    skillBodyCache.set(key, fallback);
    return fallback;
  }
}

export function detectFeishuSkillKeys(message) {
  const text = normalizeMessage(message);
  const keys = [];

  const docsPatterns = [
    /\bdocx?\b/i,
    /\bdocument\b/i,
    /\bmarkdown\b/i,
    /\bmd\b/i,
    /\bdoc\b/i,
    /\bword\b/i,
    /文档/,
    /云文档/,
    /知识库/,
    /飞书文档/,
    /文稿/,
    /起草/,
    /编写/,
    /撰写/,
    /总结/
  ];
  if (matchesAny(text, docsPatterns)) {
    keys.push('docs');
  }

  const slidesPatterns = [
    /\bppt\b/i,
    /\bslides?\b/i,
    /\bpresentation\b/i,
    /幻灯片/,
    /演示文稿/,
    /演示/
  ];
  if (matchesAny(text, slidesPatterns)) {
    keys.push('slides');
  }

  const sheetsPatterns = [
    /\bexcel\b/i,
    /\bcsv\b/i,
    /\bsheets?\b/i,
    /\bspreadsheet\b/i,
    /表格/,
    /电子表格/,
    /工作表/
  ];
  if (matchesAny(text, sheetsPatterns)) {
    keys.push('sheets');
  }

  const drivePatterns = [
    /\bdrive\b/i,
    /云空间/,
    /上传/,
    /下载/,
    /移动/,
    /删除/,
    /重命名/,
    /文件夹/
  ];
  if (matchesAny(text, drivePatterns)) {
    keys.push('drive');
  }

  return [...new Set(keys)];
}

export async function buildFeishuSkillInstruction(message) {
  const keys = detectFeishuSkillKeys(message);
  if (!keys.length) {
    return '';
  }

  const bodies = await Promise.all(keys.map((key) => readSkillBody(key)));
  return [
    'CodexMobile Feishu/Lark fast skills are enabled for this request.',
    'Use only the matched short skills below; do not spend time browsing docs or running `--help` unless a command fails for syntax.',
    'If any global Lark skill conflicts with these fast skills, follow these fast skills; they match the currently installed lark-cli.',
    'The backend already provides a writable `LARKSUITE_CLI_CONFIG_DIR`; do not copy `.lark-cli`, do not run config bind, and do not use `Remove-Item` for Lark setup.',
    'Prefer one direct lark-cli command plus one verification command. Use `--as user`. Ask before destructive delete/overwrite/move. Never reveal secrets or tokens.',
    'Final answer to the user must be concise Chinese: result, link, and any required next step only.',
    '',
    ...bodies.map((body, index) => `## ${keys[index]}\n${body}`)
  ].join('\n\n');
}
