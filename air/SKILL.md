---
name: air-workflow
description: Planning-first methodology using Air - a filesystem-based planning tool. Use when working with Air documents, managing project specifications, tracking implementation progress, or when the user mentions Air, airctl commands, or planning-first workflows.
compatibility: Requires airctl CLI tool and air-config.toml configuration
metadata:
  version: "0.1"
  author: Re
---

# Air Planning-First Methodology

Air is a filesystem-based planning solution that treats directories and files as the primary interface for project management. Air believes that planning is the most important step of any work - whether it's software development, exercise routines, household chores, or any other endeavor.

## Core Principles

1. **Filesystem as Database** - All planning in files and directories accessible to any tool
2. **Planning-First** - Plan before acting, execute from complete specifications
3. **State-Based Tracking** - Document states provide clear visibility into progress
4. **Git-Aware** - Leverages version control without requiring it

## Document Lifecycle States

Documents progress through these states:

```
draft → ready → work-in-progress → complete
  │       │              │             │
  ├───────┴──────────────┘             │
  │                                    │
  ▼                                    ▼
dropped                            archive/
```

**State Definitions:**
- `draft` - Planning phase, requirements gathering
- `ready` - Specification complete, approved for implementation
- `work-in-progress` - Currently being implemented
- `complete` - Implementation finished and tested
- `dropped` - No longer needed or deprioritized
- `unknown` - Missing or malformed metadata

## Quick Start Workflow

### 1. Check Current Status
Always start by checking what work exists and its state:

```bash
# See all work in progress
airctl status --state work-in-progress

# Check what's ready for implementation
airctl status --state ready

# View work by feature area
airctl status --by-tag

# Machine-readable JSON output (path, title, state, tags, dates)
airctl status --json
```

#### Inspect a Single Document

Use `airctl show` to display a document's content and metadata:

```bash
# Display document content (uses $PAGER if set)
airctl show v0.1/feature-name.org

# Print to stdout without pager
airctl show v0.1/feature-name.org --raw

# Structured JSON output (path, title, state, tags, created_date, updated_date, content)
airctl show v0.1/feature-name.org --json
```

### 2. Creating New Features

For new features without Air documents:

1. **Check for existing specifications first**
   ```bash
   airctl status --state draft,ready
   ```

2. **Create Air document in appropriate version directory** (v0.1/, v0.2/)
   - Use templates: `airctl template list` to see available templates
   - Start with `state: draft` (Org-mode: `#+state: draft`, Markdown: `state:` in frontmatter)
   - Add title and tags (Org-mode: `#+title:` and `#+FILETAGS:`, Markdown: `title:` and `tags:` in frontmatter)

3. **Complete required sections:**
   - Summary - Brief overview
   - Motivation - Why this work is needed (with Goals / Non-Goals)
   - Proposal - Detailed specification
   - History - Track all work with date-prefixed bullets

4. **Group related documents in subdirectories** (e.g. `git-integration/`, `air-template/`)
   - Prefer granular docs over monolithic specs — each doc should be independently implementable
   - If a spec covers multiple features, split it before implementation

5. **Move to 'ready' only when:**
   - All sections complete
   - Technical approach confirmed
   - Dependencies identified
   - Stakeholder approval received


### 3. Implementing Features

**Before starting implementation:**

```bash
# Update state to work-in-progress
airctl update v0.1/feature-name.org --state work-in-progress
```

**During implementation:**
- Update History with major milestones
- If the design diverges from the spec, document what actually shipped (a "Design Divergence" subsection under History is fine)
- Write tests based on Air document specifications
- Run tests after any code changes

**Before marking complete:**
1. Run all tests - must pass without exceptions
2. Run integration tests
3. Fix any failing tests immediately
4. Update History with completion date; note any remaining items as future work
5. Update state to complete:
   ```bash
   airctl update v0.1/feature-name.org --state complete
   ```

### 4. Managing Work

**Update document metadata:**
```bash
# Change state
airctl update path/to/doc.org --state work-in-progress

# Add tags
airctl update path/to/doc.org --add-tag reviewed

# Update multiple properties
airctl update path/to/doc.org --state complete --title "New Title"
```

**Track progress:**
```bash
# View specific directory
airctl status --directory v0.1/

# Include archived documents
airctl status --include-archive

# Verbose output with dates and tags
airctl status --verbose

# JSON output for scripting and tool integration
airctl status --json
```

## Directory Structure

Standard Air project layout:

```
./air/
├── v0.1/              # Current milestone specifications
├── v0.2/              # Next milestone planning
├── archive/           # Completed work (excluded from status by default)
├── templates/         # Document templates
└── context/           # Generated context files for AI tools
```

**Organization guidelines:**
- Use semantic versioning: v0.1, v0.2, v0.10 (sorts correctly)
- Move completed work to archive/ when no longer actively referenced
- Place OVERVIEW.md in directories to explain contents

## Context Generation for AI Tools

Generate comprehensive project context for AI assistants:

```bash
# Generate all context files
airctl context generate

# Generate with Claude-specific formatting
airctl context generate --claude
```

Generated context includes:
- Project overview and architecture
- Current work status from Air documents
- Coding conventions and standards
- Implementation guidelines

## Document Format

Air supports both Org-mode and Markdown formats. Choose based on your preference.

### Org-mode Format

```org
#+title: Feature Name
#+state: draft
#+FILETAGS: :tag1:tag2:

* Summary
Brief overview of what this addresses.

* Motivation
Why this work is needed and what problems it solves.

** Goals
What we want to achieve.

** Non-Goals
What is explicitly out of scope.

* Proposal
Detailed specification of the solution.

* Design Details
Technical implementation details.

* History
- YYYY-MM-DD: Description of work completed
```

### Markdown Format

```markdown
---
title: Feature Name
state: draft
tags: [tag1, tag2]
---

# Summary
Brief overview of what this addresses.

# Motivation
Why this work is needed and what problems it solves.

## Goals
What we want to achieve.

## Non-Goals
What is explicitly out of scope.

# Proposal
Detailed specification of the solution.

# Design Details
Technical implementation details.

# History
- YYYY-MM-DD: Description of work completed
```

## Best Practices

### Planning Phase
- Create Air documents before implementing complex features
- Complete specifications before moving to 'ready' state
- Identify dependencies between documents
- Get stakeholder approval before implementation
- If something goes wrong during implementation, **stop and re-plan** — update the Air doc before continuing

### Implementation Phase
- Only implement from 'ready' documents
- Update state immediately when starting work
- Keep History current
- Document any design deviations
- Never mark complete with failing tests
- **Verify beyond tests**: demonstrate correctness by running the actual tool, checking output, not just passing tests
- **Fix bugs autonomously**: when encountering errors, fix them directly — don't ask for hand-holding on obvious failures

### Corrections and Lessons
When the user corrects a mistake or points out a better approach:
- Capture the pattern in the relevant context file (e.g. `air-conventions.md`, `implementation-guide.md`)
- Write it as a concrete rule, not a vague guideline
- This prevents the same mistake from recurring in future sessions

### Maintenance
- Review document states regularly with `airctl status`
- Archive completed work that's no longer referenced
- Update specifications when requirements change
- Regenerate context files after document changes

## Common Commands Reference

```bash
# Initialize Air structure
airctl init

# Configuration management
airctl config create        # Interactive wizard
airctl config show          # View current config

# Directory setup
airctl directory init       # Create Air directories

# Template management
airctl template list        # Show available templates
airctl template init        # Configure which built-in templates are enabled
airctl template generate    # Create a new template file
airctl template generate --default  # Copy all built-ins to disk

# Status tracking
airctl status              # Show all documents
airctl status --state ready,work-in-progress
airctl status --by-state   # Group by state
airctl status --by-directory  # Group by directory
airctl status --by-tag     # Group by tags
airctl status --json       # Machine-readable JSON output

# Inspect a document
airctl show <path>         # Display content (uses $PAGER)
airctl show <path> --raw   # Print to stdout without pager
airctl show <path> --json  # Structured JSON (metadata + content)

# Document updates
airctl update <path> --state <state>
airctl update <path> --add-tag <tag>
airctl update <path> --remove-tag <tag>
airctl update <path> --title "New Title"

# Context generation
airctl context generate
airctl context generate --claude
```

## Troubleshooting

**Unknown states appearing:**
- Check document has state property (Org-mode: `#+state:`, Markdown: `state:` in frontmatter)
- Verify state value is one of: draft, ready, work-in-progress, complete, dropped
- Ensure file extension matches configured file-types (.org or .md by default)

**Documents not appearing in status:**
- Verify files are in main-directory configured in air-config.toml
- Check file extensions match configured file-types
- Ensure documents aren't in archive/ (use --include-archive to see them)

**Configuration issues:**
- Run `airctl config show` to see current configuration
- Check air-config.toml exists in project root or user config directory
- Verify directory paths in configuration are correct

## Collaboration Workflow

**For team members:**
1. Check `airctl status` to see current work
2. Review 'ready' documents before implementing
3. Use `airctl update` to claim work (move to work-in-progress)
4. Keep History updated
5. Update state when finished

**For project leads:**
1. Review draft documents for completeness
2. Approve documents by moving to 'ready' state
3. Monitor progress with `airctl status --state work-in-progress`
4. Plan releases based on completed milestones
5. Manage archive to keep active work visible

## Integration with Git

- Air documents live alongside code in version control
- Commit document updates with related code changes
- Use document states to plan pull request scope
- Tag releases based on completed Air milestones
- Git history can provide document timestamps (falls back to filesystem)

---

For more details, see context files in ./air/context/:
- OVERVIEW.md - Project overview
- air-conventions.md - Document structure and tag taxonomy
- architecture.md - System architecture
- implementation-guide.md - Coding standards
- interface-design.md - CLI design patterns
