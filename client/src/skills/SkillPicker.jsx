// Mobile-friendly bottom-sheet skill picker. Opens when the user taps the
// "技能" button in the composer; lists the available skills (fetched once at
// app bootstrap from GET /api/skills) with a search input and per-row toggle.
// Closes on backdrop tap, escape, or the explicit close button.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import {
  filterSkillsByQuery,
  isSkillSelected,
  toggleSkill
} from './skill-selection.js';

const SOURCE_LABELS = {
  claude: '~/.claude/skills',
  repo: '仓库内置',
  unknown: ''
};

export function SkillPicker({ open, availableSkills, selectedSkills, onChange, onClose }) {
  const [query, setQuery] = useState('');
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function handleKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      setQuery('');
    }
  }, [open]);

  const filtered = useMemo(
    () => filterSkillsByQuery(Array.isArray(availableSkills) ? availableSkills : [], query),
    [availableSkills, query]
  );

  if (!open) return null;

  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) {
      onClose?.();
    }
  }

  function handleToggle(skill) {
    const next = toggleSkill(selectedSkills, skill);
    onChange?.(next);
  }

  return (
    <div className="skill-picker-backdrop" role="presentation" onClick={handleBackdropClick}>
      <div className="skill-picker-sheet" ref={dialogRef} role="dialog" aria-modal="true" aria-label="选择技能">
        <header className="skill-picker-header">
          <h3>选择技能</h3>
          <button type="button" className="ghost-icon" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="skill-picker-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索技能名称或描述"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <ul className="skill-picker-list">
          {filtered.length ? filtered.map((skill) => {
            const checked = isSkillSelected(selectedSkills, skill);
            return (
              <li key={skill.path}>
                <button
                  type="button"
                  className={`skill-picker-row ${checked ? 'is-selected' : ''}`}
                  onClick={() => handleToggle(skill)}
                  aria-pressed={checked}
                >
                  <span className="skill-picker-row-check" aria-hidden="true">
                    {checked ? <Check size={14} /> : null}
                  </span>
                  <span className="skill-picker-row-body">
                    <strong>{skill.name || '(unnamed skill)'}</strong>
                    {skill.description ? <small>{skill.description}</small> : null}
                    {SOURCE_LABELS[skill.source] ? (
                      <small className="skill-picker-row-source">{SOURCE_LABELS[skill.source]}</small>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          }) : (
            <li className="skill-picker-empty">
              {availableSkills?.length ? '没有匹配的技能' : '暂无可用技能'}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
