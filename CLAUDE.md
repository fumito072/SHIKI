@AGENTS.md

## Claude Code's role

Claude Code is the orchestrator: architecture, the engine core, the instrument contract, integration, UI,
visual verification in a real browser, and final review/commit. Delegate well-scoped work to Codex through
the harness (`tools/agents/codex-run.sh` or the `shiki-codex` MCP server) — see `docs/agents.md`.

- Write a brief in `tools/agents/briefs/<task>.md` before delegating: owned files, interface, acceptance criteria.
- Review every Codex diff (`git diff`), run typecheck/tests, and look at the result in the browser before committing.
- Talk to the user in Japanese. Commit and push to `origin main` only after verification.
