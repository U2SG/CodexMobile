# Contribution contract

## One issue, one bounded outcome

Use GitHub Issues as the authoritative execution queue. Check existing issues/PRs before starting. Each PR states its user-visible outcome, evidence, tests, and explicit non-goals. Findings not necessary for that outcome become separate issues, not an ever-growing diff.

Work in an isolated branch/worktree. Never reset, stash, clean, overwrite, or commit someone else's dirty worktree. The original private/local repository and its running services are not this public repository's deployment target. No automatic merge, service restart, or deployment without an explicit owner instruction.

## Verify without overloading the workstation

Run lightweight targeted tests locally. Full server/client suites, load probes, production builds, and cross-platform checks belong in GitHub Actions. Record exact results; a unit test is not a live-device performance result. Do not start real agent turns in ordinary tests.

UI changes need before/after mobile evidence, keyboard/scroll behavior, and the reduced-motion case. Browser automation failure must remain visible; do not bypass an interstitial, tool safety block, or a tab claimed by another session.

## Privacy

Never commit credentials, pairing codes, real tailnet addresses, personal session content, local settings, deployment scripts, certificates, uploads, or raw screenshots. Use synthetic fixtures and reserved example hostnames. Preserve upstream attribution and licensing. Run the publication check before every push; it is a guardrail, not a complete security audit.
