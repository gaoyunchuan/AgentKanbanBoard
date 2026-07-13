# Agent Maintained Knowledge

This section is maintained by automation. Keep user-authored project instructions outside the managed block.

<agent-maintained-knowledge>

## Project Knowledge

- Coding: `docs/agent/coding.md` — Load when writing, editing, reviewing, refactoring, or explaining code; when adding features or bug fixes; when touching constants, configuration, validation, user-visible errors, or public APIs.
- Environment: `docs/agent/environment.md` — Load when setting up or troubleshooting local development, runtime dependencies, versions, environment variables, containers, or machine-specific behavior.
- Build: `docs/agent/build.md` — Load when compiling, packaging, generating artifacts, changing build scripts, diagnosing build failures, or preparing commands that produce deployable outputs.
- Deploy: `docs/agent/deploy.md` — Load when preparing, executing, reviewing, or troubleshooting releases, rollbacks, traffic shifts, production changes, or deployment commands.
- Known errors: `docs/agent/errors.md` — Load when diagnosing errors, failures, regressions, flaky behavior, confusing logs, or recurring symptoms already seen in this project.
- Infrastructure: `docs/agent/infrastructure.md` — Load when working with machines, networks, storage, middleware, cloud resources, topology, permissions, or environment-level dependencies.
- Testing: `docs/agent/testing.md` — Load when writing, running, selecting, mocking, or debugging tests; when changing test data, fixtures, integration dependencies, or CI test behavior.

## Update Policy

Automatically maintain:

- `docs/agent/coding.md`
- `docs/agent/errors.md`
- `docs/agent/environment.md`
- `docs/agent/build.md`
- `docs/agent/testing.md`
- `AGENTS.md` managed block synchronization only when missing or outdated

Require review:

- `docs/agent/deploy.md`
- `docs/agent/infrastructure.md`
- `AGENTS.md` changes outside managed block synchronization

## Loading Rule

Before starting a task, scan the `Project Knowledge` triggers above and load every detailed knowledge document whose trigger matches the current work. For coding work, always load `docs/agent/coding.md` before editing, reviewing, or explaining code.

</agent-maintained-knowledge>



# AgentKanbanBoard

## 编码约定

- 直接在main开发，不用拉分支
