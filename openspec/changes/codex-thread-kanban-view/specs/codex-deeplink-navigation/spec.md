## ADDED Requirements

### Requirement: Open Codex thread details
The system SHALL provide navigation from a Kanban thread item to the corresponding Codex Desktop thread.

#### Scenario: Open existing thread
- **WHEN** a user selects Open in Codex for a thread with a Codex session id
- **THEN** the system SHALL open `codex://threads/<thread-id>` using the thread id as the session UUID

#### Scenario: Missing thread id
- **WHEN** a thread item has no valid Codex session id
- **THEN** the system SHALL disable the Open in Codex action and show a recoverable error state

### Requirement: Open Codex project entry
The system SHALL provide navigation from a registered project to a new Codex Desktop thread entry for that project.

#### Scenario: Open project path
- **WHEN** a user selects Open Project in Codex for a project with an absolute local path
- **THEN** the system SHALL open `codex://new?path=<encoded_project_path>`

#### Scenario: Open project with prompt
- **WHEN** a user selects a project action that includes a prompt template
- **THEN** the system SHALL open a Codex new-thread deep link with encoded path and prompt query parameters

#### Scenario: Invalid project path
- **WHEN** a project has no valid absolute local path
- **THEN** the system SHALL prevent deep link launch and ask the user to fix the project registration

### Requirement: Keep execution in Codex Desktop
The system SHALL use deep links only for navigation and must not execute Codex tasks itself.

#### Scenario: User opens a project
- **WHEN** the system launches a Codex project deep link
- **THEN** Codex Desktop SHALL remain responsible for thread creation, user prompt submission, approval, command execution, and thread details

#### Scenario: User opens thread details
- **WHEN** the system launches an existing thread deep link
- **THEN** the Kanban system SHALL NOT mutate Codex thread history, turns, approvals, or command state
