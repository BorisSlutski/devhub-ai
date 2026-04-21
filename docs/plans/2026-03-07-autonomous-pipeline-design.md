# Autonomous Pipeline Design

## Overview

Optional feature that runs an autonomous plan-implement-validate-review loop for coding tasks. User describes a task in the DevHub-AI UI, and the pipeline works through it without intervention.

## Architecture

```
Task Input (UI) -> Planner -> Implementer -> Validator -> Reviewer -> Done/Retry
                   worktree-0  worktree-1    worktree-1   worktree-2
```

### Stages

1. **Planner** — reads codebase, produces structured plan (PIPELINE_PLAN.md). Temporary worktree, discarded after.
2. **Implementer** — executes the plan in its own worktree. Gets retry feedback if looping.
3. **Validator** — runs build + test commands in implementer's worktree. No AI, pure mechanical checks.
4. **Reviewer** — fresh worktree, reviews the diff blind. Can approve or request changes.

### Retry Loop

- If validator fails or reviewer requests changes, feedback goes to implementer (up to N retries).
- After exhausting retries, pipeline pauses and notifies user.

### Isolation

- Each agent gets its own git worktree (max isolation).
- Reviewer never sees implementation process, only the final diff.

## Settings (per-project)

- `enabled` — toggle pipeline on/off
- `buildCommand` — override auto-detect
- `testCommand` — override auto-detect
- `maxRetries` — default 3

## UI

- Pipeline button in Claude sessions tab bar
- Side panel with: task input, settings, run history
- Stage progress indicator (4-dot stepper)
- Expandable logs per stage
- Cancel button for active runs

## Files

- `src/shared/pipeline-types.ts` — shared types
- `src/main/pipeline-manager.ts` — orchestrator
- `src/renderer/components/PipelineView.tsx` — UI
- Config stored in `~/.devhub-ai/pipeline-configs.json`
