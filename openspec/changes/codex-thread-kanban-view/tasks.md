## 1. Project Setup

- [x] 1.1 Confirm app shell choice and initialize the desktop app structure for Tauri, React, TypeScript, and SQLite.
- [x] 1.2 Add shared domain types for projects, Codex threads, board statuses, review states, fixed fields, filter presets, and sync events.
- [x] 1.3 Add configuration for foreground sync interval, background sync interval, review-pending settle time, and reviewed retention window.

## 2. Local Persistence

- [x] 2.1 Create SQLite schema and migrations for `projects`, `codex_threads`, `thread_events`, and `filter_presets`.
- [x] 2.2 Implement repository functions for project CRUD, thread upsert, field updates, status updates, archive actions, event inserts, and preset queries.
- [x] 2.3 Seed built-in filter presets for Running, Review Pending, Untriaged, and Archived.
- [x] 2.4 Add persistence tests for default field values, enum validation, archived visibility, and idempotent thread upsert.

## 3. Codex Read-Only Sync

- [x] 3.1 Implement a Codex app-server client wrapper for read-only thread list/read/status data.
- [x] 3.2 Add a guard that prevents the sync layer from calling Codex execution or mutation methods such as thread start, turn start, approval, shell command, delete, archive, unarchive, and metadata update.
- [x] 3.3 Implement initial sync for recent threads, storing id, name, preview, cwd, source kind, Codex status, timestamps, and raw status values.
- [x] 3.4 Implement foreground/background periodic refresh and optional runtime status event handling.
- [x] 3.5 Add sync error handling that keeps the last local snapshot visible and preserves user-maintained fields.
- [x] 3.6 Add sync tests for unavailable app-server, unknown status, unchanged thread data, and duplicate event prevention.

## 4. Project Classification

- [x] 4.1 Implement project registry screens or commands for creating, editing, disabling, and listing projects.
- [x] 4.2 Implement project matching by exact cwd, child cwd, origin URL, and alias.
- [x] 4.3 Implement longest-path-wins behavior when multiple project paths match the same thread cwd.
- [x] 4.4 Classify unmatched threads as unknown and include them in untriaged views.
- [x] 4.5 Re-run classification for affected unarchived threads when project configuration changes.
- [x] 4.6 Add classification tests for exact match, child path match, origin URL match, alias match, longest path precedence, inactive projects, and unknown fallback.

## 5. Board Status Engine

- [x] 5.1 Implement runtime-to-board status mapping for `untriaged`, `running`, `review_pending`, `reviewed`, and `archived`.
- [x] 5.2 Track `first_seen_at`, `last_seen_running_at`, `last_seen_completed_at`, `manual_status_override`, and `archived_at`.
- [x] 5.3 Implement conservative review-pending transition after a previously running thread becomes inactive and remains stable for the configured settle time.
- [x] 5.4 Preserve manual reviewed and archived decisions across sync cycles unless the thread is observed running again.
- [x] 5.5 Implement mark reviewed, archive, and unarchive actions with event logging.
- [x] 5.6 Add status engine tests for new threads, running threads, waiting-on-approval threads, completed threads, reviewed protection, archived protection, and reviewed-then-running transitions.

## 6. Fields, Filtering, and Presets

- [x] 6.1 Implement fixed field editing for task type, module, sprint, and notes.
- [x] 6.2 Enforce enum values for task type.
- [x] 6.3 Implement structured filtering by project, board status, Codex status, task type, module, sprint, archive flag, and updated time range.
- [x] 6.4 Implement sorting for Running and Review Pending views according to waiting approval, updated time, and review age.
- [x] 6.5 Add filter tests for combined filters, built-in presets, archived hidden by default, and reviewed retention.

## 7. User Interface

- [x] 7.1 Build the main navigation with Inbox, Running, Review Pending, All Active, Archived, and Projects entries.
- [x] 7.2 Build the Kanban view with columns for untriaged, running, review pending, reviewed, and archived when archive display is enabled.
- [x] 7.3 Build the Running focused list with project, thread title, Codex status, sub status, last activity, and Open in Codex action.
- [x] 7.4 Build the Review Pending focused list with project, thread title, last activity, Open in Codex, Mark reviewed, and Archive actions.
- [x] 7.5 Build filter controls for project, type, sprint, status, and Show archived.
- [x] 7.6 Build thread card and row components that expose fixed field editing, archive/unarchive, mark reviewed, and status badges.

## 8. Codex Deep Link Navigation

- [x] 8.1 Implement Open in Codex for existing threads using `codex://threads/<thread-id>`.
- [x] 8.2 Implement Open Project in Codex using `codex://new?path=<encoded_project_path>`.
- [x] 8.3 Implement optional project prompt template links with encoded path and prompt query parameters.
- [x] 8.4 Validate thread ids and project paths before launching deep links and show recoverable UI errors for invalid targets.
- [x] 8.5 Add navigation tests for existing thread links, project path links, prompt links, missing thread ids, and invalid project paths.

## 9. Verification

- [x] 9.1 Add unit tests for domain mapping, repositories, filters, project classification, and board status transitions.
- [x] 9.2 Add integration tests for sync worker behavior using a mocked Codex app-server client.
- [x] 9.3 Add UI tests for Running, Review Pending, All Active, Archived, field editing, mark reviewed, archive, and unarchive flows.
- [x] 9.4 Add a manual smoke checklist covering app start, initial sync, project registration, status mapping, focused views, filters, archive behavior, and Codex deep links.
- [x] 9.5 Run formatting, linting, type checking, unit tests, integration tests, and UI smoke tests before marking the change implemented.
