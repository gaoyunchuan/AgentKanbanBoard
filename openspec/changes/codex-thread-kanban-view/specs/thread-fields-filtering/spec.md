## ADDED Requirements

### Requirement: Maintain fixed thread fields
The system SHALL maintain a fixed set of user-editable fields for each synced thread.

#### Scenario: Default field values
- **WHEN** a thread is first synced
- **THEN** the system SHALL initialize priority to `P2`, review state to `none`, risk level to `low`, and leave owner, reviewer, task type, module, sprint, and notes empty

#### Scenario: Edit fixed fields
- **WHEN** a user updates a thread field
- **THEN** the system SHALL persist the field update locally without writing the change back to Codex Desktop

#### Scenario: Validate field enum
- **WHEN** a user edits priority, task type, review state, or risk level
- **THEN** the system SHALL restrict the value to the configured enum for that field

### Requirement: Provide focused views
The system SHALL provide first-level focused views for running work and pending reviews.

#### Scenario: Running view
- **WHEN** a user opens the Running view
- **THEN** the system SHALL show unarchived threads whose board status is `running`, prioritizing waiting-on-approval items and recently updated items

#### Scenario: Review Pending view
- **WHEN** a user opens the Review Pending view
- **THEN** the system SHALL show unarchived threads whose board status is `review_pending`, prioritizing high priority, high risk, and oldest pending review items

#### Scenario: All Active view
- **WHEN** a user opens the default active view
- **THEN** the system SHALL show unarchived threads in `untriaged`, `running`, `review_pending`, and recent `reviewed` statuses

### Requirement: Support structured filtering
The system SHALL support structured filtering by project, status, Codex status, review state, priority, owner, reviewer, task type, module, sprint, risk level, archive flag, and updated time range.

#### Scenario: Combined filters
- **WHEN** a user applies multiple filters
- **THEN** the system SHALL return only threads matching all selected filter conditions

#### Scenario: Built-in presets
- **WHEN** the application initializes its local database
- **THEN** the system SHALL create built-in presets for Running, Review Pending, My Reviews, High Priority, Untriaged, and Archived

#### Scenario: Archived hidden by default
- **WHEN** a user views any non-archived preset or board
- **THEN** the system SHALL exclude archived threads unless the filter explicitly includes archived threads
