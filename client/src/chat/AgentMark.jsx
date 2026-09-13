// Icon that renders the agent's identity: Bot for claude, Code2 for codex.
// Extracted from App.jsx (Batch B R5).

import { Bot, Code2 } from 'lucide-react';

export function AgentMark({ agent, size = 30 }) {
  const Icon = agent.id === 'claude' ? Bot : Code2;
  return <Icon size={size} />;
}
