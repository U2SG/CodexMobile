# CodexMobile

Mobile-first PWA for operating local Codex and Claude Code sessions over a trusted private network. This independent fork focuses on reliable task state, reconnect recovery, measurable latency, and clear mobile interaction.

> A public source repository is not a public-service deployment recommendation. The bridge can execute code and access local files. Keep it behind a trusted private network and review the selected agent permission mode before sending work.

## Status

The initial import is a sanitized snapshot of an existing local fork, including in-progress product changes. It is **not** a verified release. Full tests/builds run in GitHub Actions; browser/phone acceptance is tracked separately. Existing services are not changed by this repository.

## Run locally

Node.js 24 and npm are the development/CI baseline. Configure and authenticate your local Codex CLI or Claude Code CLI separately.

```sh
git clone https://github.com/U2SG/CodexMobile.git
cd CodexMobile
npm ci
# Copy .env.example to .env and configure only the options you need.
npm run build
npm run start:env
```

The sample configuration binds to loopback. Open http://127.0.0.1:3321 on the host and pair with the random code printed at startup. For a phone, configure your own private HTTPS reverse proxy/Tailscale service. Do not copy another person's pairing code, API keys, or host addresses. `CODEXMOBILE_AGENT=claude` selects Claude Code; use a separate port and `CODEXMOBILE_HOME` for simultaneous instances.

## Checks

- `npm run check:publication`: reject tracked credentials, real private-network hostnames, and runtime state.
- `npm run test:server`: Node server tests.
- `npm run test:client`: pure client tests and JSX smoke tests.
- `npm run smoke:load`: isolated load smoke (CI only on constrained hosts).
- `npm run build`: production build (prefer CI on constrained hosts).

Local development should use only the targeted tests relevant to a change. Do not run high-memory builds or complete load suites on the owner's workstation.

## Direction and contribution

See [source baseline](docs/source-baseline.md) and [contribution rules](CONTRIBUTING.md). GitHub Issues are the authoritative work queue. Initial priorities are reliable cancellation, foreground reconnection, latency measurement, and a separate mobile interaction audit. Live visual acceptance is still pending; no current-device screenshots or performance gains are claimed.

## Origin and license

Derived from [RNG2018-mlxg/CodexMobile](https://github.com/RNG2018-mlxg/CodexMobile), with local extensions and independent development here. Original MIT copyright/license is retained in [LICENSE](LICENSE). Private Git history, deployment scripts, runtime state, session transcripts, and existing UI screenshots were deliberately not imported.
