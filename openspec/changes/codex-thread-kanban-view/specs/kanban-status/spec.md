## ADDED Requirements

### Requirement: Map Codex runtime status to board status
The system SHALL map Codex thread runtime information into board statuses used by the Kanban view.

#### Scenario: New synced thread
- **WHEN** a thread is first synced and has no running history
- **THEN** the system SHALL set its board status to `untriaged` unless it is archived

#### Scenario: Running thread observed
- **WHEN** a thread is active, running, or waiting for approval
- **THEN** the system SHALL set its board status to `running`

#### Scenario: Running thread finishes
- **WHEN** a thread previously observed as running is no longer running, has not changed for at least 2 minutes, is not waiting for approval, and is not archived
- **THEN** the system SHALL set its board status to `review_pending`

### Requirement: Protect manual review decisions
The system SHALL preserve manual user decisions across sync cycles.

#### Scenario: Reviewed thread remains reviewed
- **WHEN** a user marks a thread as reviewed and the thread is not observed running again
- **THEN** the system SHALL keep the board status as `reviewed`

#### Scenario: Archived thread remains archived
- **WHEN** a thread is archived in the Kanban system
- **THEN** the system SHALL keep it hidden from default active views and MUST NOT automatically move it to running or review pending

#### Scenario: Reviewed thread runs again
- **WHEN** a reviewed thread is later observed running again
- **THEN** the system SHALL move it to `running` and record a status transition event

### Requirement: Support review and archive actions
The system SHALL allow users to manually mark threads reviewed, archive threads, and restore archived threads.

#### Scenario: Mark reviewed
- **WHEN** a user marks a thread as reviewed
- **THEN** the system SHALL set board status to `reviewed`

#### Scenario: Archive thread
- **WHEN** a user archives a thread
- **THEN** the system SHALL set board status to `archived`, set the archive flag, set archived time, and remove the thread from default active views

#### Scenario: Unarchive thread
- **WHEN** a user restores an archived thread
- **THEN** the system SHALL clear the archive flag and return the thread to the latest non-archived board status that can be inferred from local events, defaulting to `review_pending`
