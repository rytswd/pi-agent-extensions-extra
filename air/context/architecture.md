# System Architecture

<!-- TODO: Replace with your project's architecture description -->

## Core Philosophy

<!-- TODO: Describe your project's core philosophy and principles -->
This project follows planning-first principles, where planning documents serve as the single source of truth for requirements and specifications.

## Design Principles

<!-- TODO: Define your project's specific design principles -->
<!-- Example principles that work well with Air:

### Filesystem as Database
- No complex databases required - files and directories store all data
- Version-aware directory structure (v0.1, v0.2, v0.10 sort correctly)
- Works with any text editor and file explorer
- Universal accessibility across different platforms and tools

### Planning-First Workflow
- Planning documents serve as single source of truth
- Execution follows documented specifications
- Progress tracking through document states
- Git integration for versioning without dependency

### Simplicity and Maintainability
- Straightforward approaches over complex solutions
- Clear separation of concerns between components
- Extensible design that allows future complexity when needed
- Balance between functionality and maintainability
-->

## System Architecture

<!-- TODO: Describe your project's architecture -->
<!-- Example structure that works well with Air:

```
project/
├── core/            # Core business logic
├── cli/             # Command-line interface
├── web/             # Web interface (optional)
└── air/             # Air documentation directory
    ├── v0.1/        # Current milestone
    ├── v0.2/        # Next milestone
    ├── templates/   # Document templates
    └── context/     # Generated context files
```

### Core Components
- **Purpose**: Contains main business logic
- **Responsibilities**: [Your core functionality]
- **Design**: [Your design principles]

### Interface Layer
- **Purpose**: User interaction and presentation
- **Framework**: [Your chosen framework]
- **Responsibilities**: User input, output formatting
-->

## Core Components

<!-- TODO: Describe your project's main components -->

### 1. Configuration System
<!-- Air provides a configuration system that you can use -->
The project uses Air's configuration system:

#### air-config.toml
- Main directory: `./air/`
- Template directory: `./air/templates/`
- Archive directory: `./air/archive/`
- Context directory: `./air/context/`
- Supported file types: `.org` (default), `.md`

<!-- TODO: Add your project-specific configuration needs -->

### 2. Document State Management
<!-- Air provides predefined states for tracking work progress -->
The project uses Air's six predefined states:

```
draft → ready → work-in-progress → complete
   ↓                                  ↓
dropped                           archive/
```

These states help track progress through the planning-first workflow.

<!-- TODO: Describe how states apply to your specific project workflow -->

### 3. Date Tracking System

#### Layered Date Resolution Strategy
**Priority Order**: Try multiple sources for robustness
1. **Document metadata** (explicit dates in headers) - highest priority
2. **Git history** - reliable timestamps when available
3. **Filesystem metadata** - universal fallback

#### Implementation Approach
- Use git2 crate with workspace-level dependency management
- Simple git operations focused on Air's core needs
- Graceful degradation when Git is unavailable
- Cache date information to avoid repeated git operations

### 4. Document Scanner and Metadata Extraction

#### Multi-Format Support
- **Org-mode**: Native support with orgize crate
- **Markdown**: YAML/TOML front matter parsing
- **Extensible**: Architecture allows adding new formats

#### Performance Design
- Use `ignore` crate for fast file discovery with .gitignore respect
- Parallel processing with `rayon` for large document sets
- Metadata cache (future) for improved performance

#### Metadata Sources
- YAML front matter (---...---)
- TOML front matter (+++...+++)
- Org-mode properties (#+PROPERTY: value)
- Custom Air properties: state, tags, title

### 5. Directory-Based Progress Tracking

#### Conceptual Design
- **Directory Categories**: Each subdirectory represents logical grouping
- **Progress per Category**: Status command shows statistics per directory
- **Configurable Grouping**: Users define custom directory structures
- **Visual Hierarchy**: Box rendering for clear separation

#### Implementation Requirements
1. **Enhanced Scanner**: Group documents by parent directory during scanning
2. **Directory Configuration**: User-specified directory tracking
3. **Progress Calculations**: Count states per directory
4. **Visual Components**: BoxPrinter for directory-level summaries
5. **Filtering Options**: Directory-specific filtering and patterns

### 6. Context Generation System (Future)

#### Architecture Components
1. **ContextGenerator**: Core class in air-core
   - Scans Air documents and extracts metadata
   - Analyzes patterns and conventions
   - Generates context files from templates

2. **Template System**: For consistent file generation
   - Embedded templates for each context file type
   - Placeholder system for dynamic content
   - Markdown formatting utilities

3. **Tool File Generators**: Tool-specific formatters
   - ClaudeGenerator: Creates CLAUDE.md with @references
   - CursorGenerator: Creates .cursor/rules
   - CopilotGenerator: Creates .github/copilot-instructions.md

## Technology Stack

<!-- TODO: Replace with your project's technology stack -->
<!-- Example sections to consider:

### Language and Runtime
- **Language**: [Your primary language]
- **Version**: [Language version/edition]
- **Key Features**: [Important language features you use]

### Key Dependencies
- **Framework**: [Your main framework]
- **Database**: [If applicable]
- **Testing**: [Testing framework]
- **Build Tools**: [Build system]
- **Other Tools**: [Additional important dependencies]

### Build System
- **Build Tool**: [Your build system]
- **Package Management**: [How you manage dependencies]
- **Linting**: [Code quality tools]
-->

## Performance Considerations

<!-- TODO: Add your project's specific performance considerations -->

### File System Operations
- Use `ignore` crate for efficient directory traversal
- Respect .gitignore patterns to avoid scanning unnecessary files
- Parallel processing for large document sets
- Incremental scanning for changed files only

### Memory Management
- Stream processing for large files where possible
- Lazy loading of document content
- Efficient string handling with Rust's ownership system
- Metadata cache (future) to reduce repeated parsing

### Git Operations
- Cache git repository handles
- Batch git operations when possible
- Fallback strategies when git operations fail
- Optional git integration - never required for core functionality

## Error Handling Strategy

<!-- TODO: Describe your project's error handling approach -->

### Error Types
- **Configuration Errors**: Invalid TOML, missing files, permission issues
- **Document Errors**: Invalid metadata, unsupported formats
- **Git Errors**: Repository access, permission issues
- **IO Errors**: File system access, network issues

### Error Reporting
- Use `thiserror` for structured error handling
- Chain errors with `?` operator for clean code flow
- Provide actionable error messages with suggestions
- Graceful degradation when optional features fail

### Recovery Strategies
- Fallback to defaults for missing configuration
- Continue processing when individual documents fail
- Provide partial results with warnings
- Clear indication of what failed and why

## Future Architecture Considerations

<!-- TODO: Describe planned architectural improvements and extensions -->

### Scalability
- Metadata cache with SQLite for large document sets
- Incremental updates instead of full rescans
- Streaming APIs for very large projects
- Background processing for expensive operations

### Extensibility
- Plugin system for custom document formats
- Hook system for external tool integration
- Custom state definitions (post-v0.1)
- API endpoints for web interface integration

### Multi-User Support
- Shared configuration management
- Conflict resolution for concurrent edits
- User-specific views and preferences
- Audit logging for document changes