## ADDED Requirements

### Requirement: Sync Codex threads read-only
The system SHALL synchronize local Codex threads through read-only app-server capabilities and persist a local snapshot for board rendering.

#### Scenario: Initial thread sync
- **WHEN** the application starts
- **THEN** the system SHALL fetch recent Codex threads and persist their id, name, preview, cwd, source kind, Codex status, created time, updated time, and last synced time

#### Scenario: Read-only boundary
- **WHEN** the sync worker communicates with Codex app-server
- **THEN** the system MUST NOT call thread start, turn start, approval, shell command, delete, archive, unarchive, metadata update, or other Codex execution write methods

#### Scenario: Incremental refresh
- **WHEN** the application is open in the foreground
- **THEN** the system SHALL refresh thread snapshots periodically and update changed runtime status or metadata without duplicating existing threads

### Requirement: Preserve sync and status events
The system SHALL record meaningful synchronization and board-status transitions in an event log.

#### Scenario: Running status observed
- **WHEN** a synced thread is observed as running
- **THEN** the system SHALL update the thread snapshot and record an event containing the previous board status and new board status

#### Scenario: Thread data unchanged
- **WHEN** a sync cycle returns a thread whose tracked fields have not changed
- **THEN** the system SHALL avoid creating duplicate thread events

### Requirement: Handle Codex availability
The system SHALL gracefully handle Codex app-server being unavailable or returning partial data.

#### Scenario: App-server unavailable
- **WHEN** the sync worker cannot connect to Codex app-server
- **THEN** the system SHALL keep the last local snapshot visible and surface a sync error state without modifying user-maintained fields

#### Scenario: Unknown Codex status
- **WHEN** a thread has an unrecognized runtime status
- **THEN** the system SHALL store the raw status value and avoid destructive board-status changes
