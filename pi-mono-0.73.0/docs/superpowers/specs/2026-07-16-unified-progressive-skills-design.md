# Unified Progressive Skills Design

## Context

PI Coding Web currently models reusable instructions as two different classes:

- selectable skills under `data/skills`
- mandatory skills under `data/default-skills`

Chat always exposes `skill_load` and `skill_resource`, even when the server catalog is empty. The browser also discards the server's `promptSkills` metadata and starts the agent with an empty system prompt. With no legal skill names in context, a model can invent names and repeatedly call `skill_load`. This was reproduced with an empty catalog and the request `生成贪吃蛇游戏`: the model tried `skill-code-generator` and `code-generator`, and both calls failed.

The default-skill path creates a separate problem. Chat expands every default skill into every transformed prompt, while the Agent V2 worker automatically adds every default skill to every run. This eager loading increases context use and weakens task focus as the collection grows.

The replacement follows the Agent Skills progressive-disclosure model:

1. disclose bounded metadata for discoverable skills;
2. load one `SKILL.md` only after explicit or permitted implicit activation;
3. load referenced resources only when needed.

## Goals

- Use one skill type, one configured directory, one catalog, and one authorization model.
- Remove the `default-skills` directory and `PI_DEFAULT_SKILLS_DIR` capability completely.
- Prevent Chat from exposing skill tools when no implicitly invokable skills exist.
- Prevent the model from inventing or loading names outside the disclosed catalog.
- Keep explicit skill invocation available for every configured skill.
- Support OpenAI's `agents/openai.yaml` invocation policy.
- Make Chat and application generation share discovery, validation, loading, and resource-security behavior.
- Keep permanent platform rules in a base system prompt rather than in an always-loaded skill.
- Preserve historical session rendering without preserving default-skill loading behavior.

## Non-goals

- No server-side keyword matcher or additional model call to auto-select skills.
- No automatic implicit skill selection for Agent V2 application generation in this change.
- No compatibility alias for `PI_DEFAULT_SKILLS_DIR`.
- No migration of non-existent skill content; both current runtime skill directories contain only placeholder files.
- No executable skill scripts in the browser or Agent V2 worker.
- No change to the two session modes or their existing prompt routing.

## Chosen architecture

### 1. One catalog and one directory

`StorageConfig` retains only `skillsDir`. `WorkspaceSkillService` scans only this directory and returns one catalog:

```ts
type SkillListResult = {
  skills: SkillSummary[];
  diagnostics: ResourceDiagnostic[];
};

type SkillSummary = {
  name: string;
  description: string;
  location: string;
  allowImplicitInvocation: boolean;
  interface?: SkillInterfaceMetadata;
};
```

There is no `defaultSkills` or `promptSkills` list. Consumers derive the implicit catalog with:

```ts
skills.filter((skill) => skill.allowImplicitInvocation)
```

This avoids two representations of the same policy.

`PI_DEFAULT_SKILLS_DIR` becomes a retired environment variable. Configuration loading fails with a bounded message that tells the operator to move each skill directory under `PI_SKILLS_DIR` and use `agents/openai.yaml` for invocation policy. It is not silently ignored.

The tracked `data/default-skills/.gitkeep` placeholder and documentation for the second directory are removed. The local ignored `.env` entry is removed during migration so the development service remains startable.

### 2. Standards-aligned invocation policy

`SKILL.md` continues to require standard `name` and `description` frontmatter. The non-standard `disable-model-invocation` frontmatter field is removed.

`WorkspaceSkillService` reads this optional metadata:

```yaml
policy:
  allow_implicit_invocation: false
```

from `agents/openai.yaml`. The default is `true`, matching OpenAI's documented policy. A skill with implicit invocation disabled:

- remains visible in the user skill selector;
- can be invoked with `/skill:name`;
- is accepted as an explicit Agent V2 selection;
- is omitted from the Chat metadata catalog and skill activation tool allowlist.

Malformed policy metadata produces a diagnostic and uses the safe value `false`; malformed interface-only metadata does not grant implicit invocation.

### 3. Bounded catalog disclosure

A shared pure catalog formatter builds the Chat skill section from name, description, and virtual location only. Full instructions and resource names are excluded.

The formatter receives the active model context-window size. Its output budget is the smaller of:

- 2% of the context window, estimated at four characters per token;
- 8,000 characters.

When space is constrained, it keeps deterministic name ordering, shortens descriptions, then omits trailing entries. An explicit warning in the catalog states how many entries were omitted. It never emits a partial XML/structured entry.

The base Chat system prompt contains stable platform rules plus the catalog. If there are no implicitly invokable skills, it contains no skill catalog or skill-tool instructions.

Permanent platform requirements belong in the base prompt module. This repository currently has no real content under `data/default-skills`, so there is no instruction body to migrate.

### 4. Chat activation flow

Before dispatch, Chat constructs one immutable skill runtime snapshot for the prompt. The snapshot contains the complete catalog, the bounded implicit catalog, explicitly selected skills, successful activations, listed resources, and per-prompt caches. System-prompt disclosure, transformed messages, and tool authorization all consume this same snapshot.

- No implicit catalog and no explicit selection: register no skill tools.
- Non-empty implicit catalog: register `skill_load` and `skill_resource` with the snapshot activation registry.
- Explicit selection with an empty implicit catalog: preload the selected instructions and register only `skill_resource`; do not expose `skill_load`.
- `skill_load` accepts only an exact name in the catalog snapshot used to build the system prompt.
- A successful activation is cached for the prompt and rendered once.
- Repeating the same valid activation returns the cached result without another HTTP request or duplicate activity card.
- A name outside the snapshot is rejected before a server request and cannot be repaired by guessing additional arbitrary names.
- `skill_resource` accepts a skill only after successful activation and accepts only a resource path returned by that activation.
- Each resource result is cached per prompt.

The API performs the same authorization checks again. Browser state is not trusted.

Explicit `/skill:name` is handled before the model call. The client validates it against the complete catalog, including skills with implicit invocation disabled. Unknown names fail once with a user-facing error and the prompt is not submitted. Explicit instructions and their listed resource paths are inserted into the current prompt snapshot; the instructions are not copied into unrelated later requests. If the instructions require a listed resource, the snapshot-scoped `skill_resource` tool can read it without making the skill implicitly invokable.

### 5. Application-generation flow

Agent V2 keeps explicit selection through `/skill:name` and uses the same complete catalog for browser validation and worker authorization.

The worker loads only `selectedSkillNames`. It does not append any server-default names. For each selected skill it:

1. verifies exact authorization against the current server catalog;
2. loads the selected `SKILL.md` once per run execution context;
3. loads only safe text resources whose relative paths are explicitly referenced by `SKILL.md`;
4. enforces the existing instruction, resource-count, per-resource, and aggregate limits;
5. records `skill_applied` only after successful loading.

Application generation remains explicit-only for this change. Adding implicit Agent V2 selection would require a new routing model step or tool-capable planning loop and is intentionally outside scope.

### 6. API and UI changes

`GET /api/pi-skills` returns `skills` and `diagnostics` only. The load and resource endpoints retain their current bounded server-side behavior.

The settings status tab shows:

- total available skills;
- implicitly invokable skills;
- explicitly-only skills;
- diagnostics.

It removes all default-skill terminology and metrics.

The slash selector lists every configured skill and marks explicitly-only entries. Empty-state copy points only to `data/skills/<skill-name>/SKILL.md`.

No new `default-skill-load` messages are created. The old custom message renderer is renamed and kept as a legacy read-only renderer so existing saved sessions remain readable; it has no loading or steering function.

### 7. Error behavior

- Empty catalog is a normal state, not an error.
- Catalog API failure disables skill tools and surfaces one diagnostic in settings.
- An explicitly requested missing skill blocks submission with one actionable error.
- An implicit activation outside the disclosed allowlist is rejected locally and logged once for the prompt.
- A skill removed between browser discovery and server activation fails once with a stale-catalog message and asks the user to refresh.
- Resource traversal, absolute paths, unlisted paths, unsupported extensions, and oversize files remain rejected.
- Agent V2 records structural worker diagnostics without exposing server filesystem paths.

## Data flow

### Chat

```text
WorkspaceSkillService.list
  -> browser receives one catalog
  -> derive allowImplicitInvocation catalog
  -> build bounded system-prompt metadata
  -> register tools only when implicit catalog is non-empty
  -> model activates an exact disclosed name
  -> server re-authorizes and returns SKILL.md
  -> optional listed resources load on demand
```

### Application generation

```text
WorkspaceSkillService.list
  -> slash selector validates explicit names
  -> selectedSkillNames stored in durable run input
  -> worker reloads current catalog
  -> worker re-authorizes exact names
  -> selected SKILL.md and explicitly referenced resources enter model context
```

## Security and trust boundaries

- The browser catalog is advisory; server catalog authorization is authoritative.
- Skill names and resource paths require exact matches.
- Virtual `skill://` locations are disclosed instead of absolute server paths.
- No skill scripts execute in Chat or Agent V2.
- Skill instructions are trusted server configuration; referenced resource contents remain separately delimited as untrusted context.
- Existing symlink, canonical-path, extension, and byte-limit protections remain mandatory.
- A catalog snapshot is immutable for one prompt/run so disclosure and authorization cannot drift inside a single model turn.

## Test strategy

### Unit and package integration

- Configuration rejects `PI_DEFAULT_SKILLS_DIR` with migration guidance.
- Discovery has one directory and no default-skill collision branch.
- `agents/openai.yaml` defaults implicit invocation to true and parses false.
- Invalid policy metadata is diagnosed and cannot grant implicit invocation.
- Catalog formatting respects deterministic ordering and exact budgets.
- Empty implicit catalog produces an empty tool list.
- Valid implicit activation loads once and deduplicates repeated calls.
- Unknown names cause no network request.
- Resource access requires prior activation and exact listed paths.
- Explicit invocation accepts explicitly-only skills and rejects missing skills once.
- Agent V2 loads only explicitly selected names.
- Existing Agent V2 instruction and resource limits still hold.
- Skill API and status UI use the simplified response shape.
- Legacy saved default-skill messages remain renderable but cannot be created.

### Browser acceptance

1. With an empty skills directory, start a new Chat and send `生成贪吃蛇游戏`; verify zero skill cards and a normal response.
2. Install one implicitly invokable test skill, send a matching Chat request, and verify exactly one activation.
3. Send a request that invites repeated use of the same matching skill and verify one activation request and one card for that prompt.
4. Install an explicitly-only skill and verify a plain matching request does not activate it.
5. Invoke the explicitly-only skill with `/skill:name` and verify successful application.
6. In application generation, run once without a skill and once with an explicit skill; verify only the latter records `skill_applied`.
7. Reload both sessions and verify durable activity/history does not duplicate.

Temporary acceptance fixtures are removed after verification and never committed.

## Acceptance criteria

- The original empty-catalog Chat reproduction produces no `Skill load failed` cards.
- `default-skills`, `defaultSkills`, `defaultSkillsDir`, `promptSkills`, `disable-model-invocation`, and active default-skill loading paths are absent from production behavior.
- `PI_DEFAULT_SKILLS_DIR` is rejected with a clear migration error.
- One standards-aligned catalog controls Chat disclosure, explicit selection, API authorization, and Agent V2 authorization.
- Full skill instructions enter context only after explicit or permitted implicit activation.
- Resources load only after activation and only by exact listed path.
- Chat and application-generation regression suites, root checks, mirror audit, Worker build, and browser acceptance all pass.

## References

- [Agent Skills specification](https://agentskills.io/specification)
- [Agent Skills client implementation guide](https://agentskills.io/client-implementation/adding-skills-support)
- [OpenAI: Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Anthropic Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
