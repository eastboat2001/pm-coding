import { createHash } from "node:crypto";
const MAX_SKILLS = 16;
const MAX_INSTRUCTION_CHARS = 96_000;
const MAX_RESOURCES = 8;
const MAX_RESOURCE_CHARS = 32_000;
const MAX_RESOURCE_TOTAL_CHARS = 64_000;
export class AgentV2SkillContextError extends Error {
    code;
    constructor(code) {
        super(code === "skill_not_authorized"
            ? "A selected skill is not authorized by the server."
            : code === "skill_limit_exceeded"
                ? "Server-loaded skill context exceeds the safety limit."
                : code === "skill_resource_failed"
                    ? "A referenced skill resource could not be loaded."
                    : "A selected skill could not be loaded.");
        this.code = code;
        this.name = "AgentV2SkillContextError";
    }
}
export function loadAgentV2SkillContext(input) {
    const catalog = input.skills.list();
    const authorizedNames = new Set(catalog.promptSkills.map((skill) => skill.name));
    if (input.selectedSkillNames.some((name) => !authorizedNames.has(name))) {
        throw new AgentV2SkillContextError("skill_not_authorized");
    }
    const names = uniqueNames([
        ...catalog.defaultSkills.filter((skill) => !skill.disableModelInvocation).map((skill) => skill.name),
        ...input.selectedSkillNames,
    ]);
    if (names.length > MAX_SKILLS)
        throw new AgentV2SkillContextError("skill_limit_exceeded");
    let instructionChars = 0;
    let resourceChars = 0;
    const skills = [];
    const resources = [];
    for (const name of names) {
        let loaded;
        try {
            loaded = input.skills.load({ name });
        }
        catch {
            throw new AgentV2SkillContextError("skill_load_failed");
        }
        if (loaded.name !== name || !loaded.content.trim())
            throw new AgentV2SkillContextError("skill_load_failed");
        instructionChars += loaded.content.length;
        if (instructionChars > MAX_INSTRUCTION_CHARS)
            throw new AgentV2SkillContextError("skill_limit_exceeded");
        skills.push({ name: loaded.name, location: loaded.location, content: loaded.content });
        for (const resource of loaded.resources) {
            if (!loaded.content.includes(resource.path))
                continue;
            if (resources.length >= MAX_RESOURCES)
                throw new AgentV2SkillContextError("skill_limit_exceeded");
            let loadedResource;
            try {
                loadedResource = input.skills.readResource({ name, path: resource.path });
            }
            catch {
                throw new AgentV2SkillContextError("skill_resource_failed");
            }
            if (loadedResource.name !== name ||
                loadedResource.path !== resource.path ||
                loadedResource.content.length > MAX_RESOURCE_CHARS) {
                throw new AgentV2SkillContextError("skill_resource_failed");
            }
            resourceChars += loadedResource.content.length;
            if (resourceChars > MAX_RESOURCE_TOTAL_CHARS)
                throw new AgentV2SkillContextError("skill_limit_exceeded");
            resources.push({
                skillName: name,
                path: loadedResource.path,
                content: loadedResource.content,
                checksum: `sha256:${createHash("sha256").update(loadedResource.content).digest("hex")}`,
            });
        }
    }
    return { skills, resources };
}
function uniqueNames(names) {
    return [...new Set(names)];
}
//# sourceMappingURL=agent-v2-skill-context.js.map