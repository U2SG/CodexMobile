// Pairing onboarding shown when the device has no auth token. Renders a
// six-digit code form and probes /api/status in the background so the
// agent-specific copy (Claude vs Codex pairing title / hint / accent) is
// correct as soon as it loads.
//
// Extracted from App.jsx (Batch G R22). Self-contained: owns its own
// code/error/pairing/entryStatus state; only depends on api helpers and
// the agent-meta + AgentMark presentation modules.

import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { apiFetch, setToken } from '../api.js';
import { agentMeta } from '../agent-meta.js';
import { AgentMark } from '../chat/AgentMark.jsx';
import { DEFAULT_STATUS } from '../app/default-status.js';

export function PairingScreen({ onPaired, initialStatus }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);
  const [entryStatus, setEntryStatus] = useState(initialStatus || DEFAULT_STATUS);
  const agent = agentMeta(entryStatus);

  useEffect(() => {
    let ignore = false;
    apiFetch('/api/status')
      .then((nextStatus) => {
        if (!ignore) {
          setEntryStatus(nextStatus || DEFAULT_STATUS);
        }
      })
      .catch(() => null);
    return () => {
      ignore = true;
    };
  }, []);

  async function handlePair(event) {
    event.preventDefault();
    setPairing(true);
    setError('');
    try {
      const result = await apiFetch('/api/pair', {
        method: 'POST',
        body: {
          code,
          deviceName: `${agent.shortLabel} ${navigator.platform || 'mobile'}`
        }
      });
      setToken(result.token);
      onPaired();
    } catch (err) {
      setError(err.message);
    } finally {
      setPairing(false);
    }
  }

  return (
    <main className={`pairing-screen ${agent.accentClass}`}>
      <div className="pairing-shell">
        <div className="pairing-mark">
          <AgentMark agent={agent} size={30} />
        </div>
        <div className="pairing-copy">
          <span>{agent.providerLabel}</span>
          <h1>{agent.pairingTitle}</h1>
          <p>{agent.pairingHint}</p>
        </div>
        <div className="pairing-status">
          <span>主机</span>
          <strong>{entryStatus.hostName || '本机'}</strong>
          <span>模型</span>
          <strong>{entryStatus.modelShort || entryStatus.model || '--'}</strong>
        </div>
        <form className="pairing-form" onSubmit={handlePair}>
          <input
            inputMode="numeric"
            maxLength={6}
            placeholder="6 位配对码"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <button type="submit" disabled={code.length !== 6 || pairing}>
            {pairing ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
            连接
          </button>
        </form>
        {error ? <div className="pairing-error">{error}</div> : null}
      </div>
    </main>
  );
}
