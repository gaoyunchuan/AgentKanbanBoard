## ADDED Requirements

### Requirement: Maintain project registry
The system SHALL maintain a local project registry used to classify synced Codex threads.

#### Scenario: Project record creation
- **WHEN** a user registers a project
- **THEN** the system SHALL store its id, display name, absolute path, optional origin URL, aliases, active flag, created time, and updated time

#### Scenario: Inactive project
- **WHEN** a project is marked inactive
- **THEN** the system SHALL retain existing thread associations while excluding the project from default project-picking controls

### Requirement: Match thread to project
The system SHALL assign each synced thread to the best matching project using deterministic matching rules.

#### Scenario: Cwd exact match
- **WHEN** a thread cwd exactly equals a registered project path
- **THEN** the system SHALL assign the thread to that project

#### Scenario: Cwd child path match
- **WHEN** a thread cwd is inside a registered project path
- **THEN** the system SHALL assign the thread to the deepest matching project path

#### Scenario: Origin URL match
- **WHEN** a thread includes a git origin URL matching a registered project origin URL
- **THEN** the system SHALL assign the thread to that project if no more specific cwd match exists

#### Scenario: Alias match
- **WHEN** no path or origin URL match exists and the thread cwd basename matches a project alias
- **THEN** the system SHALL assign the thread to that project

### Requirement: Classify unknown projects
The system SHALL keep threads visible even when no project match is found.

#### Scenario: No matching project
- **WHEN** a synced thread cannot be matched to any registered project
- **THEN** the system SHALL classify the thread as unknown and include it in untriaged views

#### Scenario: Project registry updated
- **WHEN** a user adds or updates a project registration
- **THEN** the system SHALL re-run project classification for unarchived threads affected by the changed project rule
