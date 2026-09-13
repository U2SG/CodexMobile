function markdownImageDestination(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/[\s<>()]/.test(raw)) {
    return `<${raw.replace(/>/g, '%3E')}>`;
  }
  return raw;
}

export function useLegacyImageGenerator(env = process.env) {
  const mode = String(env.CODEXMOBILE_IMAGE_ROUTE || env.CODEXMOBILE_IMAGE_MODE || '').trim().toLowerCase();
  return mode === 'legacy' || mode === 'direct';
}

export function buildCodexTurnInput({ message, larkInstruction = '', attachments = [], selectedSkills = [] } = {}) {
  const text = [message, larkInstruction].filter(Boolean).join('\n\n');
  const input = [];
  for (const skill of Array.isArray(selectedSkills) ? selectedSkills : []) {
    if (!skill?.path) {
      continue;
    }
    input.push({
      type: 'skill',
      name: skill.name || '',
      path: skill.path
    });
  }

  if (text) {
    input.push({ type: 'text', text, text_elements: [] });
  }

  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (attachment?.kind === 'image' && attachment.path) {
      input.push({ type: 'localImage', path: attachment.path });
    }
  }

  return input.length ? input : [{ type: 'text', text: '', text_elements: [] }];
}

export function imageMarkdownFromCodexImageGeneration(item, alt = '生成图片') {
  const source = String(item?.savedPath || item?.result || '').trim();
  if (!source) {
    return '';
  }
  if (!/^data:image\//i.test(source) && !/^https?:\/\//i.test(source) && !source.startsWith('/')) {
    return '';
  }
  return `![${alt}](${markdownImageDestination(source)})`;
}
