> **Chat-first workspace**: the default UI now provides conversations, tasks, and projects. See [workspace acceptance guide](docs/chat-workspace.md) for task dependencies, multi-conversation results, and local verification limits. The legacy board remains available in Settings.

# AgentKanbanBoard

English | [简体中文](README_zh.md)

AgentKanbanBoard is a personal task workbench built around a persistent To Do tree and **Codex app-server**. Define a goal, its working directory, acceptance criteria, and dependencies; delegate it to an Agent; then manage execution, questions, approvals, delivery, and rework from the same desktop application.

The workbench creates and resumes its own Codex sessions. Codex Desktop is not required for this task execution path. The existing read-only Codex Desktop thread board remains available for imported history and annotations. The packaged app currently retains the name **Codex Thread Kanban**.

This project is open source under the [MIT License](LICENSE). See the [task workbench guide](docs/task-workbench.md) for lifecycle rules, examples, and runtime limitations.

## Features

- **Task tree with executable work**: Keep the existing To Do hierarchy, keyboard editing, dates, ordering, and notes. Delegate individual nodes without introducing a workflow canvas.
- **Explicit task ownership and prerequisites**: Set the delegator, Agent profile, workspace, instructions, acceptance criteria, and `Blocked by` tasks. Dependencies control eligibility; tree structure keeps the work organized.
- **Automatic dispatch**: Eligible tasks start Codex sessions. The scheduler permits up to two Agent executions and serializes overlapping workspaces. Explicit terminal commands reserve the same workspace, so they cannot race an Agent's writes.
- **Task-scoped execution detail**: Read streamed messages and tool output, inspect changes, browse workspace files, attach local image paths, and run or stop explicit terminal commands through app-server.
- **Human attention when needed**: The “需要我” area collects approvals, questions, review, and execution problems. Replies are bound to the exact task and execution; stale approvals cannot authorize a newer run.
- **Delivery instead of a completion guess**: An ordinary final message or `turn/completed` does not complete a task. The Agent explicitly submits its result and evidence. Human review is the default; opt-in Auto acceptance applies only after a valid submission and successful execution end.
- **Bounded continuation**: A normally ended turn without an accepted handoff can continue automatically at most twice. Real blockers wait for a dependency, user answer, or environment fix; the model is not repeatedly called to poll them.
- **Delegation and durable communication**: Agents can create child tasks, wait on their results, and send context to other delegated tasks in the same tree. Messages are retained for a subsequent eligible turn and do not bypass a pause or blocker.
- **Rework with history**: Return a delivery with specific feedback, keep earlier results and attempts, and start another execution of the same task.
- **Optional browser work**: Enable a pinned Playwright MCP server for an isolated, visible Chrome window. This needs Node.js and Chrome and is configured before the task's first session.
- **Legacy thread board**: Continue to import Codex Desktop threads, annotate, group, filter, archive locally, and follow existing Thread / Task links. This import path stays read-only.

## First Task

1. Install [Codex CLI](https://github.com/openai/codex#installing-and-running-codex-cli), for example with `npm install -g @openai/codex`. Check that `codex --version` and `codex app-server --help` run. The installed app-server must support the task workbench's experimental dynamic tools.
2. Start the Tauri desktop application using the development or build instructions below. A Vite browser preview is a UI preview and does not execute tasks.
3. Open **To Do List** (`Cmd+2`), expand **Codex 连接与账户**, and click **连接**. If `codex` is not on the desktop application's PATH, enter the executable's absolute path. Sign in with the displayed ChatGPT login flow if needed, then refresh the account and model list.
4. Create a task and choose **交给 Agent**. Set an existing absolute workspace directory, a concrete goal, acceptance criteria, and an Agent profile. Keep **提交结果后由我验收** for the first task, then choose **委派并启动**.
5. Read the task's conversation and changes. Respond to any current approval or question. Once the Agent submits and its execution ends, choose **验收通过**, or provide specific feedback and choose **反馈并返工**.

For a first smoke test, use a disposable directory and ask the Agent to create a single `hello.md`, read it back, and provide the verification result. A second task blocked by the first should wait until that delivery is accepted.

## Task Status and Execution Status

| Task status | Meaning |
| --- | --- |
| `queued` | Ready for dispatch when capacity and its workspace are available. |
| `running` | An execution is advancing this task. |
| `waiting` | Waiting for a dependency, approval, answer, or environment fix. |
| `review` | A result was explicitly submitted; acceptance is still pending. |
| `completed` | Human acceptance or the configured Auto policy accepted the delivery. |
| `paused` | Work is suspended until explicitly resumed. |
| `cancelled` | This task node was cancelled. |
| `attention` | A failure, uncertain recovery, or continuation limit needs a decision. |

Execution attempts have separate states such as running, waiting for approval, completed, failed, and interrupted. A **completed execution is not a completed task**. Auto acceptance checks the submission's structure, dependencies, and execution outcome; it is not an independent semantic verifier or an automatic Reviewer approval.

Pause and cancel apply to the selected business task node. They do not cascade to its business child tasks. Rework does not roll back files or automatically reopen every downstream task. Inspect affected work and explicitly rework the tasks that need it.

## Data and Runtime Boundaries

- The local application database defaults to `~/.codex-kanban/app.db`. It stores the task tree, configuration, dependencies, execution history, interactions, results, and legacy board metadata.
- Execution is owned by the app-server process this application starts. It uses the configured Codex account and workspace permissions. The default task settings are `on-request` approval and `workspace-write` sandboxing.
- Legacy import reads `~/.codex/state_5.sqlite` and the local thread-name index. Importing, annotating, or linking an existing Desktop thread does not resume it, approve it, or give the scheduler ownership of it.
- Existing Desktop thread links can still open `codex://` URLs. Workbench tasks use their own app-server sessions inside this application.
- **There is no background daemon.** Closing a detail panel keeps work running; exiting the desktop application stops its owned runtime. Interrupted or uncertain executions require inspection and an explicit retry on the next launch; they are not silently replayed.
- The first version is for one person and manually created work. It does not provide a team service, large-scale callback ingestion, or a visual workflow editor, and it does not claim full Codex Desktop feature parity.

## Technology Stack

- Desktop shell: Tauri 2
- Backend: Rust, rusqlite, SQLite
- Frontend: React 18, TypeScript, Vite
- UI: Tailwind CSS, Radix UI, lucide-react
- Testing: Vitest and Rust unit tests
- Build artifact: macOS `.dmg`

## Local Development

Prerequisites:

- Node.js 22 or a compatible version
- npm
- Rust stable
- Python 3 for the macOS build/install helper and fake app-server subprocess tests
- Xcode Command Line Tools on macOS; DMG creation also uses the system-provided `hdiutil`

Install frontend dependencies:

```bash
npm --prefix src-ui ci
```

Start Vite when working only on the frontend:

```bash
npm --prefix src-ui run dev
```

Run the full desktop application in Tauri development mode. Tauri starts the frontend development server according to its configuration:

```bash
cd src-ui
npm exec tauri dev
```

## Testing

Run from the repository root:

```bash
make test
```

This command runs:

- `make test-local-tools` (Python build/install helper tests)
- `npm --prefix src-ui run test`
- `cargo test --manifest-path src-tauri/Cargo.toml`

Protocol tests use a fake app-server and do not sign in to Codex or call a real model. Real account, permissions, and browser checks are a separate [desktop acceptance pass](docs/task-workbench.md#真实桌面验收边界).

## Local Build

For personal use on your Mac, first quit any running **Codex Thread Kanban**, then run from an existing repository checkout:

```bash
git pull --ff-only && make run-local
```

`make run-local` builds with an explicit **ad-hoc signature**, installs with `ditto` into `~/Applications/Codex Thread Kanban.app`, and opens that installed copy. An existing copy is preserved at a uniquely named backup path printed by the installer. This path does not build a DMG or require an Apple Developer account. Use `make install-local` to build and install without opening the app.

To create a portable development DMG instead:

```bash
make build
```

`make build-dmg` is the equivalent packaging entry point. The checked DMG is written to `src-tauri/target/release/bundle/dmg/Codex Thread Kanban_0.1.0_<arch>_development.dmg`, with `.sha256` and `.verification.json` files alongside it.

These are development builds without Apple notarization. Ad-hoc signing checks bundle integrity; it does not grant a trusted developer identity or override a managed Mac's application policy. See [local macOS use and startup checks](docs/macos-local.md) if macOS blocks opening the app.

## GitHub Actions Build

The repository includes this GitHub Actions workflow:

```text
.github/workflows/build-artifacts.yml
```

It runs when:

- Changes are pushed to `main`
- A pull request is created or updated
- `Build Artifacts` is started manually from GitHub Actions

The workflow runs tests on a macOS runner, builds with ad-hoc signing, validates the finished DMG and its contained app, then uploads the **`codex-thread-kanban-development`** artifact. It is a development artifact without Apple notarization; CI success does not guarantee that a downloaded app is allowed by every Mac's policy.

For use on your own machine, the local build command above is the primary path. No Developer ID certificate, Apple account, or notarization setup is required by this repository's current build workflow.

## Project Structure

```text
.
├── src-ui/        # React and TypeScript frontend
├── src-tauri/     # Tauri/Rust, task scheduler, app-server transport, SQLite, and legacy import
├── openspec/      # Feature designs and change specifications
├── docs/          # Task workbench guide, engineering notes, and images
├── Makefile       # Tests, local installation, and DMG build entry points
├── LICENSE        # MIT License
├── README.md      # English documentation
└── README_zh.md   # Simplified Chinese documentation
```

## License

Copyright (c) 2026 gaoyunchuan

This project is available under the [MIT License](LICENSE). You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of the software, provided that the original copyright and license notices remain in all copies or substantial portions of the software.

## Project Status

The personal task workbench and legacy thread board are under active development. The runtime uses experimental app-server dynamic tools, so compatibility must be checked against the installed Codex version. Automated state-machine and protocol tests do not replace a real-account desktop acceptance run. Browser automation is opt-in and requires a separately installed Chrome; the repository does not bundle Codex, an account, Chrome, or a background daemon.
