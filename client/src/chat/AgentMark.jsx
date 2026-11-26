// Icon that renders the agent's identity: Bot for claude, Sparkles for agy, Code2 for codex.
// Extracted from App.jsx (Batch B R5).

import { Bot, Code2, Sparkles } from 'lucide-react';

export function AgentMark({ agent, size = 30 }) {
  const Icon = agent.id === 'claude' ? Bot : agent.id === 'agy' ? Sparkles : Code2;
  return <Icon size={size} />;
}
