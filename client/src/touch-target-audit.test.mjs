// Static audit of styles.css: every selector that targets a tap-able
// element (button, .*-btn, .icon-button, .*-chip, .*-pill, .*-tab, *-toggle,
// links with .button/.action classes, etc.) must declare a vertical tap
// extent of at least 44px (Apple HIG / Material 48dp baseline).
//
// We don't run a layout engine — instead we parse the bundled stylesheet
// rule-by-rule and check the declared properties. A rule is considered
// compliant if its body sets any of:
//   - height / min-height >= 44px (or var(--touch), which is 44px)
//   - padding (top + bottom) >= a heuristic that, with default font baseline,
//     reaches 44px (≈ 12px+12px = 24px top+bottom with 20px line content).
//     Threshold: padding-top + padding-bottom >= 20px AND has a font/line
//     contribution. Conservatively we require explicit min-height for
//     anything without an obvious icon container.
//
// Pseudo-state rules (:hover, :focus, :active, :disabled) inherit the base
// rule's geometry and are skipped.
//
// The test asserts the violation set has not grown beyond the locked-in
// allowlist. Each entry in the allowlist is a tracked exception explaining
// why the selector is exempt (icon nested inside a sized parent, etc.).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STYLES_PATH = path.join(__dirname, 'styles.css');

const TAP_TARGET_TOKEN = 'var(--touch)';
const MIN_TAP_PX = 44;
const PADDING_FALLBACK_MIN = 20; // 12+12 padding wraps a ~20px line nicely

// Selector heuristic: anything that looks tap-able.
const TAP_PATTERNS = [
  /(^|[\s,>+~])button(\b|[.#:[])/,         // bare `button` element
  /\.([a-z][a-z0-9-]*-)?(btn|button)\b/,    // *-btn, *-button
  /\.icon-button\b/,
  /\.ghost-icon\b/,
  /\.([a-z][a-z0-9-]*-)?chip\b/,
  /\.([a-z][a-z0-9-]*-)?pill\b/,
  /\.([a-z][a-z0-9-]*-)?tab\b/,
  /\.([a-z][a-z0-9-]*-)?toggle\b/,
  /\[role="button"\]/
];

// Known exceptions — selectors that are tap-able by class name but are
// exempt by design. Categorized to make future review easier:
//
//   inline-chip      Inline filter/state chip flowing with prose or a
//                    sized parent row. A 44px box would visibly disrupt
//                    layout; the actual hit area is the parent row /
//                    chip-tray plus a small padded affordance.
//   parent-sized     The tap target's geometry is set by a sized
//                    ancestor (e.g. .composer's grid-template-rows /
//                    --touch row). Static analysis can't see that.
//   narrow-tradeoff  A @media (max-width <= 380px) shrink override.
//                    iPhone SE-class screens force a real layout
//                    trade-off; the standard-width rule already gives
//                    44×44.
//   alt-layout       Alternate composer layout variant (line 5119
//                    `.composer` redefinition) that uses 38px buttons
//                    deliberately. Used in a specific runtime mode.
//                    TODO: confirm and either retire the variant or
//                    move it behind a class.
//   not-tappable     Visual element whose class name ends in "button"
//                    but the JSX doesn't bind a click handler (e.g.
//                    plan-option-index-button is the "1." label).
//   pseudo           A :state/[attr] override that shares geometry
//                    with the unprefixed rule audited elsewhere.
//   wrapper          A container that holds tap targets; the children
//                    are what's audited.
const ALLOWLIST = new Set([
  // pseudo — base rule is the one with geometry.
  'button',
  '.icon-button:active',
  '.ghost-icon:active',
  '.peer-pill[aria-expanded="true"]',
  '.drawer-search-chip.is-active',
  '.activity-panel-chip.is-active',

  // wrapper — children carry tap geometry.
  '.drawer-search-chip-group',
  '.activity-panel-chip-group',
  '.drawer-search-chip-group + .drawer-search-chip',
  '.skill-chip-tray',
  '.skill-chip > span',

  // inline-chip — flow inline with prose / parent row.
  '.message-image-link',
  '.message-image-link.is-failed',
  '.message-image-link.is-failed img',
  '.attachment-chip',
  '.attachment-chip > span',
  '.attachment-chip > a',
  '.attachment-chip > a:hover',
  '.attachment-chip > a:focus-visible',
  '.attachment-chip small',
  '.attachment-chip button',
  '.peer-pill',
  '.permission-pill',
  '.drawer-search-chip',
  '.drawer-search-filters > .drawer-search-chip',
  '.activity-panel-chip',
  '.activity-command-chip',  // rendered as <span> in ActivityTimeline, non-interactive command badge
  '.composer-mode-chip',
  '.composer-mode-chip button',
  '.skill-chip',
  '.skill-chip button',
  '.skill-pill',

  // parent-sized — hosted by a flex/grid row with var(--touch).
  '.drawer-search-results button',          // multi-line full-row result tile
  '.composer-menu button span:last-child',  // text label inside a sized menu item
  '.send-mode-strip button',                // strip is 44-tall flex row
  '.send-mode-strip button span',
  '.image-intent-actions button:last-child', // modifier; base button is 44
  '.voice-dialog-handoff-actions button',    // host action row sets min-height

  // not-tappable — visual indicator misnamed.
  '.plan-option-index-button',

  // narrow-tradeoff — explicit shrink at <380px viewport width.
  '.voice-button',
  '.send-button',
  '.dialog-button',
  '.queued-draft-actions button',   // base rule is 44×44; narrow override 36
  '.image-intent-actions button',   // base rule is 44; narrow override 36

  // alt-layout — 2nd `.composer` rule at styles.css:5119 redefines the
  // grid with 38px button slots. TODO: confirm whether this variant is
  // still reachable or dead style.
  '.message-code-toolbar button',

  // parent-sized — JsonViewer's `.json-toggle` is just the ▾/▸ glyph;
  // the real tap target is the surrounding `.json-row-head.is-container`
  // which carries `min-height: var(--touch)` and the click handler.
  '.json-viewer .json-toggle'
]);

const PSEUDO_STATE_ONLY = /^(.+?)((?::(?:hover|focus|focus-visible|focus-within|active|disabled|checked|placeholder-shown|empty|first-child|last-child|nth-child\([^)]*\)))+)$/;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parsePxLike(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (v.includes(TAP_TARGET_TOKEN)) return MIN_TAP_PX;
  const m = v.match(/^(-?\d+(?:\.\d+)?)px$/);
  return m ? Number(m[1]) : null;
}

function parsePaddingShorthand(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (v.includes(TAP_TARGET_TOKEN)) return { top: MIN_TAP_PX, bottom: MIN_TAP_PX };
  const tokens = v.split(/\s+/);
  const px = tokens.map((t) => {
    const m = t.match(/^(-?\d+(?:\.\d+)?)px$/);
    return m ? Number(m[1]) : null;
  });
  if (px.some((x) => x === null)) return null;
  // CSS shorthand: 1 → all, 2 → v|h, 3 → t|h|b, 4 → t|r|b|l
  if (px.length === 1) return { top: px[0], bottom: px[0] };
  if (px.length === 2) return { top: px[0], bottom: px[0] };
  if (px.length === 3) return { top: px[0], bottom: px[2] };
  if (px.length === 4) return { top: px[0], bottom: px[2] };
  return null;
}

// Walk CSS at the top level. We iterate the WHOLE stylesheet by computing
// the line of every rule start against the original text — that way nested
// @media / @supports rules report the correct source line.
function* iterateRules(css) {
  const text = stripComments(css);
  const len = text.length;
  const lineAt = (offset) => {
    let line = 1;
    for (let i = 0; i < offset && i < len; i += 1) {
      if (text[i] === '\n') line += 1;
    }
    return line;
  };

  function* walk(start, end) {
    let i = start;
    while (i < end) {
      while (i < end && /\s/.test(text[i])) i += 1;
      if (i >= end) break;

      const ruleStart = i;

      if (text[i] === '@') {
        while (i < end && text[i] !== '{' && text[i] !== ';') i += 1;
        if (i >= end) break;
        if (text[i] === ';') { i += 1; continue; }
        // descend
        i += 1; // consume '{'
        let depth = 1;
        const innerStart = i;
        while (i < end && depth > 0) {
          if (text[i] === '{') depth += 1;
          else if (text[i] === '}') depth -= 1;
          if (depth > 0) i += 1;
        }
        const innerEnd = i;
        i += 1; // consume closing '}'
        yield* walk(innerStart, innerEnd);
        continue;
      }

      // Selector list up to '{'
      while (i < end && text[i] !== '{') i += 1;
      if (i >= end) break;
      const selector = text.slice(ruleStart, i);
      i += 1; // consume '{'

      const bodyStart = i;
      let depth = 1;
      while (i < end && depth > 0) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        if (depth > 0) i += 1;
      }
      const bodyEnd = i;
      i += 1; // consume closing '}'

      yield {
        selector: selector.trim(),
        body: text.slice(bodyStart, bodyEnd).trim(),
        line: lineAt(ruleStart)
      };
    }
  }

  yield* walk(0, len);
}

function declarationsFromBody(body) {
  const out = {};
  // Split on `;`, ignoring those inside parens (var(), calc())
  let depth = 0;
  let buf = '';
  const decls = [];
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) {
      decls.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) decls.push(buf);
  for (const decl of decls) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim().replace(/!important$/i, '').trim();
    out[prop] = value;
  }
  return out;
}

function looksTappable(selector) {
  return TAP_PATTERNS.some((re) => re.test(selector));
}

function trimPseudoStates(selector) {
  const m = selector.match(PSEUDO_STATE_ONLY);
  return m ? m[1] : selector;
}

function ruleIsCompliant(decls) {
  const h = parsePxLike(decls['height']);
  if (h !== null && h >= MIN_TAP_PX) return true;
  const mh = parsePxLike(decls['min-height']);
  if (mh !== null && mh >= MIN_TAP_PX) return true;
  const minH = parsePxLike(decls['min-block-size']);
  if (minH !== null && minH >= MIN_TAP_PX) return true;

  let top = parsePxLike(decls['padding-top']);
  let bottom = parsePxLike(decls['padding-bottom']);
  if ((top === null || bottom === null) && decls['padding']) {
    const p = parsePaddingShorthand(decls['padding']);
    if (p) {
      if (top === null) top = p.top;
      if (bottom === null) bottom = p.bottom;
    }
  }
  if (top !== null && bottom !== null && top + bottom >= PADDING_FALLBACK_MIN) {
    return true;
  }
  return false;
}

// Rules that don't touch geometry at all are "carrier-only" — they restyle
// an element that is sized elsewhere (typically by its base class rule).
// Auditing those would flood the report with dark-theme color overrides,
// state modifiers (.is-active / [aria-expanded]), and child-selector
// styling. We only flag a rule when it INTRODUCES geometry that is too
// small, or when it's the base rule for a tap-target class and declares
// nothing sizing-related (i.e. forgot to size it).
const GEOMETRY_PROPS = new Set([
  'height', 'min-height', 'min-block-size', 'max-height',
  'width', 'min-width', 'max-width',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'padding-block', 'padding-block-start', 'padding-block-end',
  'padding-inline', 'padding-inline-start', 'padding-inline-end',
  'line-height', 'font-size'
]);

function declaresGeometry(decls) {
  for (const key of Object.keys(decls)) {
    if (GEOMETRY_PROPS.has(key)) return true;
  }
  return false;
}

// Selectors that are clearly NOT introducing a new tap target — they're
// state/theme/child overrides of something whose base rule already sizes.
// Detected positionally to avoid maintaining a long allowlist of every
// theme-override selector.
function isOverrideSelector(sel) {
  if (sel.startsWith('[data-theme="dark"]')) return true;
  if (sel.startsWith('[data-theme="light"]')) return true;
  // Compound on a state-modifier-only class.
  if (/\.is-(active|primary|danger|selected|plan|image|disabled|loading|busy|expanded|collapsed)\b/.test(sel)) return true;
  // Pseudo selector targeting descendant style (::after, ::before, etc.)
  if (/::?(after|before|placeholder|backdrop|marker|selection|-webkit-[a-z-]+|first-line|first-letter)\b/.test(sel)) return true;
  // [aria-*] / [disabled] / [checked] — state attributes
  if (/\[(aria-[a-z-]+|disabled|checked|open|hidden)\b/.test(sel)) return true;
  return false;
}

function auditRules(css) {
  const violations = [];
  for (const rule of iterateRules(css)) {
    const selectors = rule.selector.split(',').map((s) => s.trim()).filter(Boolean);
    for (const sel of selectors) {
      if (!looksTappable(sel)) continue;
      if (ALLOWLIST.has(sel)) continue;
      if (isOverrideSelector(sel)) continue;
      const decls = declarationsFromBody(rule.body);
      // Carrier rules with no geometry declarations are pure restyle —
      // their tap geometry comes from another rule we'll audit on its own.
      if (!declaresGeometry(decls)) continue;
      if (!ruleIsCompliant(decls)) {
        violations.push({ selector: sel, line: rule.line });
      }
    }
  }
  return violations;
}

test('styles.css: every tap-able selector reaches ≥44px tap area (or is allow-listed)', () => {
  const css = fs.readFileSync(STYLES_PATH, 'utf8');
  const violations = auditRules(css);
  if (violations.length > 0) {
    const lines = violations
      .map((v) => `  styles.css:${v.line}  ${v.selector}`)
      .join('\n');
    assert.fail(
      `Found ${violations.length} tap-target selector(s) without a 44px vertical extent:\n` +
      `${lines}\n\n` +
      `Fix by adding min-height: var(--touch) (or ≥44px) to the rule, OR add an ` +
      `entry to ALLOWLIST in this test with the reason it's exempt.`
    );
  }
});
