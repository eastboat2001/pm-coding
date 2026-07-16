# Unified Progressive Skills Implementation Plan

> **Required sub-skill:** Use `superpowers:executing-plans` to execute this plan task by task, and use `superpowers:test-driven-development` for every behavior change.

**Goal:** Replace the split `default-skills`/`skills` implementation with one standards-aligned, progressively disclosed Skill catalog, while preventing Chat from exposing unusable skill tools and keeping Agent V2 application generation explicit-only.

**Architecture:** `WorkspaceSkillService` becomes the single discovery and authorization boundary. It returns one catalog with `allowImplicitInvocation`, derived from `agents/openai.yaml`. Chat builds one bounded metadata snapshot per prompt and creates allowlisted, cached tools from that snapshot; Agent V2 reloads the same catalog but loads only explicitly selected names. Permanent platform behavior remains in a base Chat system prompt rather than an eager Skill.

**Tech Stack:** TypeScript, Node.js, Vitest, `@mariozechner/pi-agent-core`, Vite web client, YAML frontmatter/OpenAI Skill metadata, checked-in JS/source-map mirrors in `packages/web-workspace`.

**Global Constraints:** Follow repository `AGENTS.md`: no broad test/build commands, run every modified test explicitly, use `apply_patch`, preserve unrelated changes, synchronize web-workspace TS mirrors, run root `npm run check` with full output, and never push. Do not recreate `default-skills` compatibility behavior.

---

## Task 1: Collapse server configuration and catalog to one Skill type

**Files:**

- Modify: `packages/web-workspace/test/config-diagnostics.test.ts`
- Modify: `packages/web-workspace/test/workspace-skill-service.test.ts`
- Modify: `packages/web-workspace/src/types.ts`
- Modify: `packages/web-workspace/src/config.ts`
- Modify: `packages/web-workspace/src/workspace-skill-service.ts`

### Step 1: Write failing configuration and discovery tests

Add tests that require:

```ts
expect(() => loadStorageConfig({ PI_DEFAULT_SKILLS_DIR: "./legacy" })).toThrow(
	/move each skill directory under PI_SKILLS_DIR/i,
);
```

and a single-catalog response:

```ts
expect(service.list()).toEqual({
	skills: [expect.objectContaining({ name: "page-style", allowImplicitInvocation: true })],
	diagnostics: expect.any(Array),
});
```

Add fixtures for `agents/openai.yaml` with `policy.allow_implicit_invocation: false` and malformed policy data. Assert `false` is preserved, malformed policy produces a diagnostic, and malformed metadata never grants implicit invocation.

### Step 2: Run the focused tests and confirm red

Run from `packages/web-workspace`:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/config-diagnostics.test.ts test/workspace-skill-service.test.ts
```

Expected: failures mention the still-present `defaultSkillsDir`, `defaultSkills`, `promptSkills`, and missing `allowImplicitInvocation`/retired-variable validation.

### Step 3: Implement the minimum unified model

Change the public types to:

```ts
export interface SkillSummary extends JsonObject {
	name: string;
	description: string;
	location: string;
	allowImplicitInvocation: boolean;
	interface?: SkillInterfaceMetadata;
}

export interface SkillListResult extends JsonObject {
	skills: SkillSummary[];
	diagnostics: ResourceDiagnostic[];
}
```

Remove `defaultSkillsDir` from `StorageConfig`. Reject a non-empty `PI_DEFAULT_SKILLS_DIR` with a dedicated configuration error containing bounded migration guidance. Scan only `skillsDir`; delete the default-directory collision branch and the non-standard `disable-model-invocation` parser.

Extend OpenAI metadata parsing with:

```ts
policy?: {
	allow_implicit_invocation?: boolean;
};
```

Default valid or absent policy to `true`. On malformed policy, emit one diagnostic and use `false`.

### Step 4: Run focused tests and confirm green

Run the Step 2 command again. Expected: both files pass.

### Step 5: Commit the server catalog slice

Stage only the Task 1 source/test files and commit:

```powershell
git commit -m "refactor(web-workspace): unify skill catalog"
```

## Task 2: Make Agent V2 application generation explicit-only

**Files:**

- Modify: `packages/web-workspace/test/agent-v2-skill-context.test.ts`
- Modify: `packages/web-workspace/src/agent-v2-skill-context.ts`

### Step 1: Replace the default-loading test with an explicit-only test

Use a catalog containing both selected and unselected skills, then assert:

```ts
expect(context.skills.map((item) => item.name)).toEqual(["ui-polish"]);
expect(load).toHaveBeenCalledTimes(1);
expect(load).toHaveBeenCalledWith({ name: "ui-polish" });
```

Keep the unknown-name authorization test, but use `{ skills, diagnostics }` only. Add an explicitly-only summary (`allowImplicitInvocation: false`) and prove Agent V2 accepts it when selected.

### Step 2: Run the focused test and confirm red

```powershell
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-skill-context.test.ts
```

Expected: the current implementation still reads `defaultSkills`/`promptSkills` and loads a default.

### Step 3: Implement explicit-only authorization

Authorize against every entry in `catalog.skills`, normalize/deduplicate `selectedSkillNames`, and load exactly those names. Preserve existing instruction/resource size, path, extension, and aggregate limits.

### Step 4: Run the focused test and confirm green

Run the Step 2 command again. Expected: pass.

### Step 5: Commit the Agent V2 slice

```powershell
git commit -m "refactor(agent-v2): load only selected skills"
```

## Task 3: Build the bounded Chat catalog and snapshot-scoped tools

**Files:**

- Create: `apps/pi-coding-web/src/skill-tools/catalog.ts`
- Create: `apps/pi-coding-web/test/skill-catalog.test.ts`
- Modify: `apps/pi-coding-web/src/skill-tools/tools.ts`
- Modify or create: `apps/pi-coding-web/test/skill-tools.test.ts`

### Step 1: Write catalog red tests

Cover deterministic name ordering, exclusion of `allowImplicitInvocation: false`, an empty result for an empty implicit catalog, and the exact budget rule:

```ts
const maxChars = Math.min(Math.floor(contextWindowTokens * 0.02 * 4), 8_000);
expect(formatSkillCatalog(skills, contextWindowTokens).length).toBeLessThanOrEqual(maxChars);
```

Assert no partial entry is emitted and an omission notice is present when entries are dropped.

### Step 2: Run catalog tests and confirm red

```powershell
cd apps/pi-coding-web
npx tsx ../../node_modules/vitest/dist/cli.js --run test/skill-catalog.test.ts
```

Expected: module/function does not exist.

### Step 3: Implement the pure formatter

Export `implicitSkills`, `skillCatalogBudgetChars`, and `formatSkillCatalog`. Include only name, description, and virtual location. Never include instructions, resources, or absolute paths.

### Step 4: Write tool-factory red tests

Inject a request function into the factory so tests can prove network behavior. Require:

```ts
expect(createServerSkillTools({ skills: [], request })).toEqual([]);
expect(request).not.toHaveBeenCalled();
```

For a non-empty implicit catalog, assert `skill_load` and `skill_resource` exist, an exact valid load is cached, an unknown name makes zero requests, and resource access is denied until successful activation and for paths not returned by that activation. For explicit-only selections, assert only `skill_resource` is exposed.

### Step 5: Run tool tests and confirm red

```powershell
cd apps/pi-coding-web
npx tsx ../../node_modules/vitest/dist/cli.js --run test/skill-tools.test.ts
```

Expected: current factory always returns both tools and performs unbounded requests.

### Step 6: Implement snapshot-scoped tool authorization and caches

Use one factory closure per prompt:

```ts
createServerSkillTools({
	skills,
	explicitSkillNames,
	preloadedSkills,
	request = requestSkillApi,
}): AgentTool[]
```

Derive the exact implicit allowlist from the supplied snapshot. Cache successful loads/resources, reject unknown names locally, and allow resource reads only for activated/preloaded skills and exact listed paths. Return no tools when neither implicit nor explicit activation exists.

### Step 7: Run both focused files and confirm green

```powershell
cd apps/pi-coding-web
npx tsx ../../node_modules/vitest/dist/cli.js --run test/skill-catalog.test.ts test/skill-tools.test.ts
```

### Step 8: Commit the Chat runtime primitives

```powershell
git commit -m "feat(pi-coding-web): add progressive skill runtime"
```

## Task 4: Integrate explicit commands, system prompt, and legacy rendering

**Files:**

- Modify: `apps/pi-coding-web/test/skill-command.test.ts`
- Modify: `apps/pi-coding-web/src/skill-tools/skill-command.ts`
- Create: `apps/pi-coding-web/src/skill-tools/chat-system-prompt.ts`
- Create: `apps/pi-coding-web/test/chat-system-prompt.test.ts`
- Rename: `apps/pi-coding-web/src/skill-tools/default-skill-message.ts` to `apps/pi-coding-web/src/skill-tools/legacy-default-skill-message.ts`
- Rename/modify: `apps/pi-coding-web/test/default-skill-message.test.ts` to `apps/pi-coding-web/test/legacy-default-skill-message.test.ts`
- Modify: `apps/pi-coding-web/src/app/bootstrap.ts`

### Step 1: Write explicit-command and prompt red tests

Remove `defaultSkillNames` behavior. Assert `/skill:name` loads a valid explicitly-only skill, unknown names fail once before dispatch, and unrelated later prompts do not inherit instructions. Assert the base prompt contains permanent platform rules plus bounded implicit metadata, and contains no skill-tool guidance when the implicit catalog is empty.

### Step 2: Run focused tests and confirm red

```powershell
cd apps/pi-coding-web
npx tsx ../../node_modules/vitest/dist/cli.js --run test/skill-command.test.ts test/chat-system-prompt.test.ts
```

### Step 3: Implement command/prompt integration

Simplify skill command expansion to explicit names only. Build the base system prompt with the pure catalog formatter. In `bootstrap.ts`, store only `skills` and diagnostics, derive slash suggestions from all skills, and construct one prompt runtime snapshot used by system prompt, message transformation, and tool factory. Remove `enqueueDefaultSkillLoadMessages` and never create new `default-skill-load` messages.

The legacy module must export only renderer/reader compatibility for saved messages; it must expose no enqueue or steering function.

### Step 4: Run focused tests and confirm green

Run the Step 2 command plus:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/legacy-default-skill-message.test.ts
```

### Step 5: Commit the Chat integration slice

```powershell
git commit -m "refactor(pi-coding-web): integrate unified chat skills"
```

## Task 5: Simplify API clients, storage wiring, and status UI

**Files:**

- Modify: `apps/pi-coding-web/src/skill-tools/client.ts`
- Modify: `apps/pi-coding-web/src/storage/configured-server-storage.ts`
- Modify: `apps/pi-coding-web/src/ui/SkillStatusTab.ts`
- Modify: `apps/pi-coding-web/src/ui/skill-status-summary.ts`
- Modify: `apps/pi-coding-web/test/skill-status-summary.test.ts`
- Modify relevant API/config/UI tests discovered by `rg "defaultSkills|promptSkills|defaultSkillsDir" apps/pi-coding-web packages/web-workspace`
- Modify: `packages/web-ui/src/utils/i18n.ts`

### Step 1: Write/update UI and API red tests

Require a two-way summary derived from one list:

```ts
expect(summarizeSkills(skills)).toEqual({
	available: 3,
	implicit: 2,
	explicitOnly: 1,
});
```

Update response fixtures to `{ skills, diagnostics }`. Assert fallback/error state disables skills without manufacturing legacy lists.

### Step 2: Run every modified focused test and confirm red

Use `rg` to enumerate the exact modified test files, then run them explicitly with the package-local Vitest command.

### Step 3: Implement the simplified consumers

Remove all active uses of `defaultSkills`, `promptSkills`, and `defaultSkillsDir`. Update settings labels to “可用 / 可隐式调用 / 仅显式调用” semantics and remove default-skill translations that are no longer referenced.

### Step 4: Run every modified focused test and confirm green

Repeat the exact Step 2 command. Expected: pass.

### Step 5: Commit the API/UI cleanup

```powershell
git commit -m "refactor(pi-coding-web): simplify skill status and API"
```

## Task 6: Remove the retired directory/configuration and synchronize mirrors

**Files:**

- Delete: `apps/pi-coding-web/data/default-skills/.gitkeep`
- Modify: `apps/pi-coding-web/.env.example`
- Modify: `apps/pi-coding-web/README.md`
- Modify other tracked docs/config found by the production-symbol scan
- Modify ignored local file: `apps/pi-coding-web/.env` (remove only `PI_DEFAULT_SKILLS_DIR`; do not stage)
- Regenerate checked-in `.js`/`.js.map` mirrors for every changed `packages/web-workspace/src/*.ts`

### Step 1: Add or update the quality-regression assertion

Update the existing quality regression test so tracked production files contain none of:

```text
PI_DEFAULT_SKILLS_DIR
defaultSkillsDir
defaultSkills
promptSkills
disable-model-invocation
```

Allow only the retired-variable diagnostic test/message and legacy saved-message renderer where explicitly documented.

### Step 2: Run the regression test and confirm red

Run its exact Vitest file from the owning package. Expected: current docs/config/mirrors still contain retired symbols.

### Step 3: Remove tracked and local legacy configuration

Delete the placeholder directory file, update docs/examples to one directory, and remove only the deprecated line from the ignored local `.env` so the manually started service remains valid.

### Step 4: Synchronize and audit mirrors

Use the repository's explicit web-workspace source-sync command with the changed TS file list. Then run the mirror audit command documented by the package. Inspect `git diff` to confirm only matching JS/maps changed.

### Step 5: Run the regression test and confirm green

Repeat Step 2. Expected: pass.

### Step 6: Commit cleanup and mirrors

```powershell
git commit -m "chore(skills): remove default skill configuration"
```

## Task 7: Full verification and separate browser acceptance

**Files:**

- Modify only if a verification failure exposes a real defect, following a new red test first.

### Step 1: Run every changed test file explicitly

Build the list from `git diff --name-only 588ace3..HEAD` and run each changed `*.test.ts` with its owning package's Vitest command. Capture full output.

### Step 2: Run repository checks

From the repository root:

```powershell
npm run check
```

Expected: exit 0 with no type, format, or lint failures.

### Step 3: Compile the Agent V2 worker without the prohibited broad build script

From `apps/pi-coding-web`, run the worker TypeScript compiler command used by its package configuration directly, then restart only the worker process if required. Do not stop unrelated user services.

### Step 4: Execute Chat browser acceptance

With the unified skills directory empty, start a new Chat and send `生成贪吃蛇游戏`. Verify:

- no `skill_load` request;
- no “Skill load failed” card;
- a normal Chat response.

Install temporary implicit and explicit-only fixture skills under `data/skills`, test exact implicit activation, deduplication, plain explicit-only non-activation, and `/skill:name` success. Remove fixtures afterward.

### Step 5: Execute application-generation browser acceptance separately

Run one application generation without a selected skill and one with an explicit temporary skill. Verify only the selected run records `skill_applied`, preview delivery still works, and reload does not duplicate activity. Remove fixtures afterward.

### Step 6: Perform final production-symbol and diff audit

```powershell
rg -n --hidden -g '!node_modules/**' -g '!dist/**' "defaultSkillsDir|defaultSkills|promptSkills|disable-model-invocation|PI_DEFAULT_SKILLS_DIR" .
git status --short
git diff --check 588ace3..HEAD
```

Classify any intentional legacy/test hits. Confirm no temporary fixture, generated junk, or unrelated user file is staged.

### Step 7: Apply `verification-before-completion`

Report only evidence observed in the final commands and browser runs. If any acceptance item is not run or fails, state it explicitly rather than claiming completion.
