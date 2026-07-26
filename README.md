# Codex Thread Kanban

English | [简体中文](README_zh.md)

Codex Thread Kanban is a local desktop board for Codex Desktop users. It brings Codex threads from different projects into one read-only workspace, making it easy to see which tasks are running, which ones need human review, and which historical conversations are ready to archive.

The project does not replace Codex Desktop. Instead, it adds an attention-management layer for people working with many threads in parallel: Codex Desktop continues to create and run threads, handle approvals, and display thread details, while Codex Thread Kanban synchronizes, groups, filters, annotates, archives, and opens them.

This project is open source under the [MIT License](LICENSE).

![Codex Thread Kanban board](docs/images/app-kanban.png)

## Features

- **Unified board**: Collects local Codex Desktop threads into views for all active work, review pending, running, untriaged, archived, and individual projects.
- **Reliable read-only synchronization**: Reads local Codex Desktop thread snapshots and the thread name index, keeps names aligned with Codex, and automatically excludes subagent threads. Synchronization never executes, approves, or deletes Codex work.
- **Local status management**: Maps threads to `untriaged`, `running`, `review_pending`, `reviewed`, `suspended`, and `archived` while preserving manual decisions locally.
- **Review queue**: Collects completed or waiting threads in one place for focused review.
- **Archive and restore**: Hides archived threads from active views without deleting local data or the corresponding Codex Desktop thread.
- **Project classification**: Identifies a thread's project from its working directory, origin URL, and path aliases; unmatched threads are placed under Unknown.
- **Structured annotations**: Adds `task_type`, `module`, `sprint`, and notes fields for filtering and retrospectives.
- **List and board layouts**: Uses a list for fast scanning and batch processing, or a board for status-oriented tracking.
- **Independent To Do List**: Provides a persistent tree of tasks with statuses, due dates, Markdown details, same-level drag-and-drop ordering, and keyboard-based insertion.
- **Bidirectional Thread / Task links**: Associates one thread with one task and multiple threads with the same task, with migration, undo, and navigation in both directions.
- **Efficient task organization**: Groups task trees by completion, displays 200 items per page by default, and opens linked threads directly in Codex Desktop.
- **Responsive narrow-screen layout**: Gradually compresses or hides action and date columns while preserving task and linked-thread information for as long as possible.
- **Keyboard and quick actions**: Uses `Cmd+1` / `Cmd+2` to switch between the board and To Do List, supports a navigation-free Zen mode, and can open Codex, open VS Code, or copy a session ID from a thread row.
- **Comments and large-list performance**: Loads thread comments on demand and virtualizes long lists to keep periodic refreshes lightweight.

## Who It Is For

If you regularly run several Codex Desktop tasks at once, this tool helps answer questions such as:

- Which threads are still running?
- Which threads have finished and need review in Codex Desktop?
- What Codex work has recently happened in a project?
- Which old threads can be removed from active views?
- Can I organize Codex work by module, sprint, or task type?
- Which Codex threads belong to a product task, and what is its overall progress?

## Data Boundaries

Codex Thread Kanban is a local-first, read-only sidecar application.

- Codex data source: reads `~/.codex/state_5.sqlite` and the thread name index in the same directory.
- Local board database: writes to `~/.codex-kanban/app.db` by default.
- The application stores only its own board state, manual fields, archive state, project classification, To Do tasks, and Thread / Task links.
- It does not start or resume threads, approve requests, execute shell commands, or delete Codex data.
- Codex is opened through `codex://` deep links; all subsequent execution remains in Codex Desktop.

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
- The system-provided `hdiutil` when building a dmg on macOS

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

- `npm --prefix src-ui run test`
- `cargo test --manifest-path src-tauri/Cargo.toml`

## Local Build

Run from the repository root:

```bash
make build
```

The command installs frontend dependencies, builds the Tauri application, and creates a macOS dmg at:

```text
src-tauri/target/release/bundle/dmg/
```

You can also run:

```bash
make build-dmg
```

## GitHub Actions Build

The repository includes this GitHub Actions workflow:

```text
.github/workflows/build-artifacts.yml
```

It runs when:

- Changes are pushed to `main`
- A pull request is created or updated
- `Build Artifacts` is started manually from GitHub Actions

The workflow runs tests on a macOS runner, builds the dmg, and uploads it as the `codex-thread-kanban-dmg` artifact.

## Project Structure

```text
.
├── src-ui/        # React and TypeScript frontend
├── src-tauri/     # Tauri and Rust backend, local SQLite, deep links, and synchronization
├── openspec/      # Feature designs and change specifications
├── docs/images/   # README and documentation images
├── Makefile       # Test and dmg build entry points
├── LICENSE        # MIT License
├── README.md      # English documentation
└── README_zh.md   # Simplified Chinese documentation
```

## License

Copyright (c) 2026 gaoyunchuan

This project is available under the [MIT License](LICENSE). You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of the software, provided that the original copyright and license notices remain in all copies or substantial portions of the software.

## Project Status

Codex Thread Kanban is under active development. It already supports real Codex thread synchronization, board and list views, filtering, editable metadata, review and suspension workflows, archive and restore, Codex navigation, a persistent To Do List, bidirectional Thread / Task links, and responsive narrow-screen layouts. Future work can continue to improve project configuration, synchronization compatibility, packaging, and releases.
