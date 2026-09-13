// Regression net: catches "an out-of-order mobile media query overrides
// the tap-to-reveal opacity gate on .message-actions". The desktop hover
// path (`@media (hover: hover)`) and the touch fallback (`@media
// (hover: none)`) at styles.css:2475+ together own the visibility of
// .message-actions. No OTHER rule should set `opacity` on a bare
// `.message-actions` selector (or on a non-state-qualified compound
// like `.message-row .message-actions`) — that would override the gate
// at equal specificity but later source order, and on iOS Safari the
// buttons re-appear permanently. The user hit this twice; this test
// makes it loud the third time.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STYLES_PATH = path.join(__dirname, '..', 'styles.css');

// Selectors that are PERMITTED to set opacity on .message-actions
// because they carry a state modifier or known visibility gate.
const STATE_QUALIFIED = [
  /\.message-stack\.is-revealed\s+\.message-actions/,
  /\.message-row:hover\s+\.message-actions/,
  /\.message-actions:focus-within/
];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Walk top-level + @media blocks, yielding { selector, body, line, atRuleChain }.
function* iterateRules(css) {
  const text = stripComments(css);
  const len = text.length;
  const lineAt = (offset) => {
    let line = 1;
    for (let i = 0; i < offset; i += 1) if (text[i] === '\n') line += 1;
    return line;
  };

  function* walk(start, end, chain) {
    let i = start;
    while (i < end) {
      while (i < end && /\s/.test(text[i])) i += 1;
      if (i >= end) break;

      const ruleStart = i;

      if (text[i] === '@') {
        const atRuleStart = i;
        while (i < end && text[i] !== '{' && text[i] !== ';') i += 1;
        if (i >= end) break;
        if (text[i] === ';') { i += 1; continue; }
        const atRulePrelude = text.slice(atRuleStart, i).trim();
        i += 1;
        let depth = 1;
        const innerStart = i;
        while (i < end && depth > 0) {
          if (text[i] === '{') depth += 1;
          else if (text[i] === '}') depth -= 1;
          if (depth > 0) i += 1;
        }
        const innerEnd = i;
        i += 1;
        yield* walk(innerStart, innerEnd, [...chain, atRulePrelude]);
        continue;
      }

      while (i < end && text[i] !== '{') i += 1;
      if (i >= end) break;
      const selector = text.slice(ruleStart, i);
      i += 1;
      const bodyStart = i;
      let depth = 1;
      while (i < end && depth > 0) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        if (depth > 0) i += 1;
      }
      const bodyEnd = i;
      i += 1;
      yield {
        selector: selector.trim(),
        body: text.slice(bodyStart, bodyEnd),
        line: lineAt(ruleStart),
        atRuleChain: chain
      };
    }
  }

  yield* walk(0, len, []);
}

// The two @media queries that legitimately set opacity on .message-actions:
// `(hover: hover)` for the desktop semi-visible base, `(hover: none)` for
// the mobile hidden-until-tap baseline. Any other @media setting opacity
// on .message-actions overrides these by source order.
function insideVisibilityGate(atRuleChain) {
  return atRuleChain.some((rule) => /@media\s*\(\s*hover\s*:\s*(hover|none)\s*\)/i.test(rule));
}

test('no plain `.message-actions` selector sets opacity outside the documented visibility gates', () => {
  const css = fs.readFileSync(STYLES_PATH, 'utf8');
  const offenders = [];

  for (const rule of iterateRules(css)) {
    // Skip if rule body doesn't touch opacity.
    if (!/(^|;|\s)opacity\s*:/m.test(rule.body)) continue;

    // Inside the visibility-gate media queries themselves, opacity is the policy.
    if (insideVisibilityGate(rule.atRuleChain)) continue;

    // At the very top level (no enclosing @media), the bare
    // `.message-actions` rule owns the default-hidden state
    // (opacity: 0). That's the foundation the visibility gates
    // reveal from; allow it.
    const isTopLevel = rule.atRuleChain.length === 0;

    // Split selector list — any individual selector may be the offender.
    const selectors = rule.selector.split(',').map((s) => s.trim()).filter(Boolean);
    for (const sel of selectors) {
      if (!sel.includes('.message-actions')) continue;
      if (STATE_QUALIFIED.some((pattern) => pattern.test(sel))) continue;
      // Top-level bare `.message-actions` is the documented default.
      if (isTopLevel && /^\.message-actions$/.test(sel)) continue;
      offenders.push({ selector: sel, line: rule.line, opacity: rule.body.match(/opacity\s*:\s*[^;]+/i)?.[0] });
    }
  }

  if (offenders.length > 0) {
    const lines = offenders
      .map((o) => `  styles.css:${o.line}  ${o.selector}  →  ${o.opacity}`)
      .join('\n');
    assert.fail(
      `Found ${offenders.length} rule(s) that set opacity on a non-state-qualified .message-actions selector. ` +
      `This re-densifies the mobile chat because the rule overrides the ` +
      `tap-to-reveal gate at equal specificity but later source order:\n${lines}\n\n` +
      `Either remove the opacity declaration, or qualify the selector with a state modifier ` +
      `(.message-stack.is-revealed / :hover / :focus-within / etc.) and add the pattern to ` +
      `STATE_QUALIFIED in this test.`
    );
  }
});
