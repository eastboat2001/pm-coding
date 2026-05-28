# PI Skill Writing Guidelines

PI supports server-configured global skills under `data/skills/<skill-name>/SKILL.md`.
Skills are instructions and reference material for the agent. They do not grant extra
permissions and PI does not execute skill scripts.

PI also supports backend-forced default skills under
`data/default-skills/<skill-name>/SKILL.md`. Default skills use the same file format and
quality rules, but they are not shown in the frontend skill picker. The server injects
them into every latest user request as mandatory instructions.

## Required Structure

Each skill must use this shape:

```md
---
name: frontend-design
description: Use this skill when the user asks to create, redesign, polish, or review a frontend page, static app UI, dashboard, landing page, or visual interaction flow. Apply it when the PM handoff implies a UI must be built, even if the user does not mention design directly. Do not use for backend-only, data-only, or pure documentation tasks.
---

# Frontend Design

## Purpose
Describe the specialized behavior this skill adds.

## Required Workflow
1. Read the task and identify where this skill applies.
2. Apply the skill rules before creating or editing project files.
3. Verify the result against the checklist.

## Must Follow
- List concrete, testable rules.

## Avoid
- List explicit anti-patterns and non-goals.

## When Combined With Other Skills
- Explain how this skill composes with style, domain, testing, or accessibility skills.

## Verification Checklist
- List observable checks the final page or implementation must satisfy.
```

## Frontmatter Rules

- `name` must match the directory name and use lowercase letters, numbers, and hyphens.
- `description` is the primary trigger signal for automatic model invocation.
- Start `description` with clear trigger wording such as `Use this skill when ...`.
- Include task types, synonyms, and implicit cases that should trigger the skill.
- Include non-use boundaries such as `Do not use for ...`.
- Keep `description` under 1024 characters.
- Prefer 80-300 characters for simple skills and 300-700 characters for broad skills.

## Body Rules

- Keep `SKILL.md` concise and operational. Put long examples and reference material in
  `references/` files.
- Write rules as direct instructions, not background explanation.
- Use specific UI or implementation constraints instead of vague words like "modern",
  "premium", or "beautiful" without defining what they mean.
- Include a combination policy when the skill may be selected with other skills.
- Include a verification checklist so the model has a concrete target.

## Multi-Skill Behavior

When the user explicitly selects multiple skills in PI, PI injects all selected skills as
mandatory instructions. Skill authors should still make composition explicit:

- State what this skill owns, such as visual style, layout, domain behavior, accessibility,
  testing, or content tone.
- State which source wins when rules conflict. Product requirements from PM or the user
  should stay primary.
- Avoid global rules that conflict with common page-generation skills unless the skill is
  intentionally a strict house style.

## Resource Files

PI can read text resources referenced by a loaded skill through `skill_resource`.

Recommended layout for selectable skills:

```text
data/skills/frontend-design/
  SKILL.md
  references/
    layout.md
    components.md
    accessibility.md
  agents/
    openai.yaml
```

Recommended layout for backend-forced default skills:

```text
data/default-skills/pi-platform-defaults/
  SKILL.md
  references/
    platform-rules.md
```

Use resources for:

- long examples
- design tokens
- component catalogs
- style-system details
- validation checklists

Do not rely on scripts being executable. PI lists script files as text resources only.

## Quality Checklist

Before adding a skill, verify:

- The directory name and frontmatter `name` match.
- The `description` says when to use the skill.
- The `description` says when not to use the skill.
- The first screen of the body explains the skill's purpose and workflow.
- The rules are concrete enough to evaluate in the generated static preview.
- The skill explains how it combines with other likely skills.
- Any referenced resource path is relative to the skill directory.
