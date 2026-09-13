// JSON tree viewer.
//
// Renders a parsed JSON value as a foldable tree. Container nodes (object,
// array) are tap-to-toggle rows; primitives render inline next to their
// key. Default expansion is `depth <= 1` so a large agent-emitted blob
// doesn't blast a thousand rows on first paint — the user opens what they
// care about.
//
// Parse failures fall back to a `<pre>` with an error label so the raw
// payload is still readable (and the rest of the chat bubble doesn't
// crash).

import { useState } from 'react';

const DEFAULT_EXPAND_DEPTH = 1;

function JsonPrimitive({ value }) {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === 'boolean') return <span className="json-bool">{String(value)}</span>;
  if (typeof value === 'number') return <span className="json-number">{String(value)}</span>;
  if (typeof value === 'string') return <span className="json-string">{JSON.stringify(value)}</span>;
  // Fallback for unexpected non-JSON types (e.g. undefined / functions
  // after a custom replacer). Should not appear via JSON.parse output.
  return <span className="json-other">{String(value)}</span>;
}

function summaryOf(value) {
  if (Array.isArray(value)) return `[ ${value.length} ${value.length === 1 ? 'item' : 'items'} ]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    return `{ ${keys.length} ${keys.length === 1 ? 'key' : 'keys'} }`;
  }
  return '';
}

function JsonNode({ keyLabel, value, depth }) {
  const isContainer = value !== null && typeof value === 'object';
  const [expanded, setExpanded] = useState(depth <= DEFAULT_EXPAND_DEPTH);

  function toggle() {
    if (isContainer) setExpanded((current) => !current);
  }

  function handleKeyDown(event) {
    if (!isContainer) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setExpanded((current) => !current);
    }
  }

  const arrow = isContainer ? (expanded ? '▾' : '▸') : '·';

  return (
    <li className="json-row">
      <div
        className={`json-row-head ${isContainer ? 'is-container' : 'is-leaf'}`}
        role={isContainer ? 'button' : undefined}
        tabIndex={isContainer ? 0 : undefined}
        aria-expanded={isContainer ? expanded : undefined}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        <span className="json-toggle" aria-hidden="true">{arrow}</span>
        {keyLabel != null ? <span className="json-key">{keyLabel}:</span> : null}
        {isContainer ? (
          expanded ? (
            <span className="json-summary">{Array.isArray(value) ? '[' : '{'}</span>
          ) : (
            <span className="json-summary">{summaryOf(value)}</span>
          )
        ) : (
          <JsonPrimitive value={value} />
        )}
      </div>

      {isContainer && expanded ? (
        <>
          <ul className="json-children">
            {Array.isArray(value)
              ? value.map((item, index) => (
                <JsonNode key={index} keyLabel={String(index)} value={item} depth={depth + 1} />
              ))
              : Object.entries(value).map(([childKey, childValue]) => (
                <JsonNode
                  key={childKey}
                  keyLabel={JSON.stringify(childKey)}
                  value={childValue}
                  depth={depth + 1}
                />
              ))}
          </ul>
          <div className="json-close-bracket">{Array.isArray(value) ? ']' : '}'}</div>
        </>
      ) : null}
    </li>
  );
}

function Component({ text }) {
  const source = String(text || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return (
      <div className="json-viewer is-error">
        <div className="json-viewer-error-label">JSON 解析失败：{error.message}</div>
        <pre className="json-viewer-raw">{source}</pre>
      </div>
    );
  }
  // Top-level primitive: just render it without the tree chrome.
  if (parsed === null || typeof parsed !== 'object') {
    return (
      <div className="json-viewer">
        <div className="json-row-head is-leaf">
          <JsonPrimitive value={parsed} />
        </div>
      </div>
    );
  }
  return (
    <div className="json-viewer">
      <ul className="json-tree">
        <JsonNode value={parsed} depth={0} />
      </ul>
    </div>
  );
}

function matches(pathLower, contentTypeLower) {
  if (contentTypeLower.includes('json')) return true;
  return /\.json(?:$|[:?#])/i.test(pathLower);
}

async function loader(blob) {
  const text = await blob.text();
  return { text };
}

export const JsonViewer = {
  id: 'json',
  matches,
  loader,
  Component,
  toolbar: 'plain',
  capabilities: { canEdit: true, canAdjustFont: true, acceptsInline: true }
};
