import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const styles = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('Continuous Surface follows the app shell width, not only the browser viewport', () => {
  assert.ok(styles.includes('container-type: inline-size;'));
  assert.ok(styles.includes('container-name: codexmobile-shell;'));
  const marker = styles.indexOf('/* === Continuous surface: reduce card boundaries in a narrow app shell === */');
  assert.notEqual(marker, -1);
  const blockStart = styles.indexOf('@container codexmobile-shell (max-width: 819px) {', marker);
  assert.notEqual(blockStart, -1);
  assert.ok(blockStart - marker < 200, 'Continuous Surface should start with the root container query');
  const legacyMedia = styles.indexOf('@media (max-width: 819px) {', marker);
  assert.ok(legacyMedia === -1 || legacyMedia - marker > 200, 'Continuous Surface must not fall back to viewport-only media');
});
