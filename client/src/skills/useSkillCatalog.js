// Loads the available-skills catalog from GET /api/skills once after the user
// is authenticated. Holds the selected-skills array (server-shaped entries
// with name + path) so the composer can render chips and the chat send body
// can include them. Failures fall back to an empty catalog — picker simply
// shows "暂无可用技能" instead of breaking the composer.

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

export function useSkillCatalog({ authenticated }) {
  const [availableSkills, setAvailableSkills] = useState([]);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadCatalog = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    try {
      const data = await apiFetch('/api/skills');
      if (Array.isArray(data?.skills)) {
        setAvailableSkills(data.skills);
      }
    } catch {
      setAvailableSkills([]);
    } finally {
      setLoading(false);
    }
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) {
      setAvailableSkills([]);
      setSelectedSkills([]);
      return;
    }
    loadCatalog();
  }, [authenticated, loadCatalog]);

  const clearSelectedSkills = useCallback(() => setSelectedSkills([]), []);

  return {
    availableSkills,
    selectedSkills,
    setSelectedSkills,
    clearSelectedSkills,
    refreshSkills: loadCatalog,
    skillsLoading: loading
  };
}
