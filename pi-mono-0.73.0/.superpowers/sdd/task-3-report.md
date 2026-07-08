# Task 3 Report: v2 File Adapter

## Scope

- Brief source: `.superpowers/sdd/task-3-brief.md`
- Allowed code files changed:
  - `packages/web-workspace/src/agent-v2-file-adapter.ts`
  - `packages/web-workspace/src/index.ts`
  - `packages/web-workspace/test/agent-v2-file-adapter.test.ts`

## Codegraph-first findings

- `WorkspaceFileService` already provides the underlying file I/O surface needed for Task 3 via `handle(...)`.
- The current `WorkspaceFileService.handle` commands are `list`, `get`, `create`, `rewrite`, `update`, and `delete`.
- The real `StorageConfig` shape in `packages/web-workspace/src/types.ts` differs from the brief example. The test fixture was updated to the current package contract with the minimal required field set.
- `createAgentV2ToolFailure` already exists in `packages/web-workspace/src/agent-v2-tool-governance.ts` and was reused directly.
- `AgentV2ArtifactRecord` requires `artifactId`, `kind`, `path`, `mediaType`, `checksum`, `version`, `sourceTaskId?`, `validationStatus`, and `metadataJson`; the adapter exposes a v2 artifact candidate by omitting runtime-owned fields.

## TDD record

### RED

Command:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-file-adapter.test.ts
```

Observed failure:

- `Cannot find module '../src/agent-v2-file-adapter.js'`

This confirmed the new test was exercising missing behavior rather than passing against existing code.

### GREEN

Implemented:

- `createAgentV2FileAdapter(...)`
- `AgentV2FileAdapter` and related v2 result/artifact types
- v2-to-`WorkspaceFileService` mapping for `listFiles`, `readFile`, `writeFile`, and `patchFile`
- structured path failure mapping through `createAgentV2ToolFailure`
- package re-export from `src/index.ts`

## Verification

Focused test:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-file-adapter.test.ts
```

Result:

- PASS (`2` tests passed)

Typecheck:

```powershell
npm run check
```

Result:

- PASS (`tsgo --noEmit`)

## Behavior implemented

- `writeFile` returns a v2 artifact candidate with:
  - `artifactId: file:<path>`
  - `kind: source`
  - media type inferred from extension
  - `sha256:` checksum from written content
  - `version: v2`
  - `sourceTaskId`
  - `validationStatus: not_started`
  - empty `metadataJson`
- `listFiles` and `readFile` expose a v2-shaped contract while reusing `WorkspaceFileService` underneath.
- Invalid/escaping paths are normalized into structured `file.path_invalid` failures instead of leaking raw workspace-path errors directly.

## Notes

- No old application-generation internal modules were imported or called.
- No source-adjacent JS files were generated or synced; the package’s existing TS/Vitest workflow handled the new source file directly.
- `now` is accepted on write/patch inputs to match the brief contract, but runtime-owned timestamps are intentionally not emitted in `AgentV2FileArtifactCandidate`.

## Concerns

- The brief only specified one structured failure assertion (`file.path_invalid`). The adapter currently normalizes path-validation failures and leaves other `WorkspaceFileService` errors unchanged. Expanding that error taxonomy would need an explicit follow-on contract decision.
