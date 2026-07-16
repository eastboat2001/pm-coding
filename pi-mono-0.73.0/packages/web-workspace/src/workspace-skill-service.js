import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MIN_RECOMMENDED_DESCRIPTION_LENGTH = 80;
const MAX_INTERFACE_FIELD_LENGTH = 512;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_RESOURCE_BYTES = 256 * 1024;
const MAX_LISTED_RESOURCES = 200;
const SKILL_FILE = "SKILL.md";
const OPENAI_AGENT_METADATA_PATH = ["agents", "openai.yaml"];
const DESCRIPTION_TRIGGER_PATTERN = /\b(use this skill when|use when|trigger(?:s|ed)? when|invoke when|apply when|适用|用于|使用.*时)\b/i;
const DESCRIPTION_BOUNDARY_PATTERN = /\b(do not use|don't use|not for|avoid using|unless|except when|不适用|不要用于|不要使用|除非)\b/i;
const ALLOWED_TEXT_EXTENSIONS = new Set([
    ".css",
    ".csv",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".py",
    ".sh",
    ".svg",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
]);
export class WorkspaceSkillService {
    config;
    constructor(config, _diagnostics) {
        this.config = config;
    }
    list() {
        const result = this.discover();
        return {
            skills: result.skills.map(toSummary),
            diagnostics: result.diagnostics,
        };
    }
    load(body) {
        const skill = this.resolveSkill(body.name);
        const raw = readFileSync(skill.filePath, "utf8");
        return {
            ...toSummary(skill),
            content: stripFrontmatter(raw).trim(),
            resources: listSkillResources(skill.baseDir),
        };
    }
    readResource(body) {
        const skill = this.resolveSkill(body.name);
        const requestedPath = safeRelativeSkillPath(String(body.path || ""));
        const targetPath = resolve(skill.baseDir, requestedPath);
        if (!existsSync(targetPath))
            throw new Error(`Skill resource not found: ${toPosixPath(requestedPath)}`);
        const stats = statSync(targetPath);
        if (!stats.isFile())
            throw new Error(`Skill resource is not a file: ${toPosixPath(requestedPath)}`);
        assertAllowedTextResource(targetPath, stats);
        const realBaseDir = realpathSync(skill.baseDir);
        const realTargetPath = realpathSync(targetPath);
        assertInsideRealPath(realBaseDir, realTargetPath, "Resolved skill resource path escapes skill root.");
        return {
            name: skill.name,
            path: toPosixPath(relative(realBaseDir, realTargetPath)),
            content: readFileSync(realTargetPath, "utf8"),
            size: stats.size,
        };
    }
    resolveSkill(name) {
        const normalizedName = String(name || "").trim();
        if (!normalizedName)
            throw new Error("Field `name` is required.");
        const result = this.discover();
        const skill = result.skills.find((candidate) => candidate.name === normalizedName);
        if (!skill)
            throw new Error(`Skill not found: ${normalizedName}`);
        return skill;
    }
    discover() {
        const diagnostics = [];
        const skills = discoverSkillsInDir(this.config.skillsDir, diagnostics);
        return { skills, diagnostics };
    }
}
function discoverSkillsInDir(root, diagnostics) {
    if (!root)
        return [];
    if (!existsSync(root))
        return [];
    const skills = new Map();
    const rootDir = resolve(root);
    const realRootDir = realpathSync(rootDir);
    for (const skill of scanSkills(rootDir, realRootDir, diagnostics)) {
        const existing = skills.get(skill.name);
        if (existing) {
            diagnostics.push({
                type: "collision",
                message: `name "${skill.name}" collision`,
                path: relativeToRoot(rootDir, skill.filePath),
                collision: {
                    resourceType: "skill",
                    name: skill.name,
                    winnerPath: existing.location,
                    loserPath: skill.location,
                },
            });
            continue;
        }
        skills.set(skill.name, skill);
    }
    return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function scanSkills(dir, realRootDir, diagnostics) {
    const entries = readDirectorySafe(dir);
    const rootSkill = entries.find((entry) => entry.name === SKILL_FILE && entry.isFile());
    if (rootSkill) {
        const skill = loadSkillFromFile(join(dir, rootSkill.name), basename(dir), realRootDir, diagnostics);
        return skill ? [skill] : [];
    }
    const skills = [];
    for (const entry of entries) {
        if (shouldSkipEntry(entry))
            continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            skills.push(...scanSkills(fullPath, realRootDir, diagnostics));
        }
    }
    return skills;
}
function loadSkillFromFile(filePath, expectedName, realRootDir, diagnostics) {
    const realFilePath = realpathSync(filePath);
    assertInsideRealPath(realRootDir, realFilePath, "Resolved skill path escapes configured skills root.");
    const stats = statSync(realFilePath);
    if (stats.size > MAX_SKILL_BYTES) {
        diagnostics.push({
            type: "error",
            message: `skill file exceeds ${MAX_SKILL_BYTES} bytes`,
            path: relativeToRoot(realRootDir, realFilePath),
        });
        return null;
    }
    const raw = readFileSync(realFilePath, "utf8");
    const parsed = parseFrontmatter(raw);
    const frontmatter = parsed.frontmatter;
    const frontmatterName = frontmatter.name?.trim() || "";
    const name = (frontmatterName || expectedName).trim();
    const description = frontmatter.description?.trim() || "";
    const skillDir = dirname(realFilePath);
    const diagnosticPath = relativeToRoot(realRootDir, realFilePath);
    const metadata = readOpenAiMetadata(skillDir, realRootDir, diagnostics);
    const nameErrors = validateSkillName(frontmatterName, name, expectedName);
    const descriptionErrors = validateDescriptionErrors(description);
    for (const message of nameErrors) {
        diagnostics.push({ type: "error", message, path: diagnosticPath });
    }
    for (const message of descriptionErrors) {
        diagnostics.push({ type: "error", message, path: diagnosticPath });
    }
    if (nameErrors.length > 0 || descriptionErrors.length > 0)
        return null;
    for (const message of validateDescriptionWarnings(description)) {
        diagnostics.push({ type: "warning", message, path: diagnosticPath });
    }
    return {
        name,
        description,
        filePath: realFilePath,
        baseDir: skillDir,
        location: skillLocation(name, SKILL_FILE),
        allowImplicitInvocation: metadata.allowImplicitInvocation,
        ...(metadata.interface ? { interface: metadata.interface } : {}),
    };
}
function readDirectorySafe(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    }
    catch {
        return [];
    }
}
function shouldSkipEntry(entry) {
    return entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules";
}
function toSummary(skill) {
    return {
        name: skill.name,
        description: skill.description,
        location: skill.location,
        allowImplicitInvocation: skill.allowImplicitInvocation,
        ...(skill.interface ? { interface: skill.interface } : {}),
    };
}
function listSkillResources(baseDir) {
    const resources = [];
    collectSkillResources(baseDir, baseDir, resources);
    return resources.sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_LISTED_RESOURCES);
}
function collectSkillResources(baseDir, dir, resources) {
    if (resources.length >= MAX_LISTED_RESOURCES)
        return;
    for (const entry of readDirectorySafe(dir)) {
        if (shouldSkipEntry(entry))
            continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectSkillResources(baseDir, fullPath, resources);
            continue;
        }
        if (!entry.isFile() || entry.name === SKILL_FILE || isOpenAiAgentMetadataResource(baseDir, fullPath))
            continue;
        const stats = statSync(fullPath);
        if (!isAllowedTextResource(fullPath, stats))
            continue;
        resources.push({ path: toPosixPath(relative(baseDir, fullPath)), size: stats.size });
    }
}
function isOpenAiAgentMetadataResource(baseDir, path) {
    return toPosixPath(relative(baseDir, path)) === OPENAI_AGENT_METADATA_PATH.join("/");
}
function safeRelativeSkillPath(path) {
    const normalized = path.trim().replace(/\\/g, "/");
    if (!normalized)
        throw new Error("Field `path` is required.");
    if (isAbsolute(normalized))
        throw new Error("Skill resource path must be relative.");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0)
        throw new Error("Field `path` is required.");
    for (const part of parts) {
        if (part === "." || part === ".." || part.includes(":")) {
            throw new Error("Resolved skill resource path escapes skill root.");
        }
    }
    return join(...parts);
}
function assertAllowedTextResource(path, stats) {
    if (!isAllowedTextResource(path, stats)) {
        throw new Error(`Skill resource is not an allowed text resource: ${toPosixPath(path)}`);
    }
}
function isAllowedTextResource(path, stats) {
    if (stats.size > MAX_RESOURCE_BYTES)
        return false;
    return ALLOWED_TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}
function validateSkillName(frontmatterName, name, expectedName) {
    const errors = [];
    if (!frontmatterName)
        errors.push("name is required in SKILL.md YAML frontmatter");
    if (name !== expectedName)
        errors.push(`name "${name}" does not match skill path "${expectedName}"`);
    if (name.length > MAX_NAME_LENGTH)
        errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
    if (!/^[a-z0-9-]+$/.test(name)) {
        errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
    }
    if (name.startsWith("-") || name.endsWith("-"))
        errors.push("name must not start or end with a hyphen");
    if (name.includes("--"))
        errors.push("name must not contain consecutive hyphens");
    return errors;
}
function validateDescriptionErrors(description) {
    if (!description)
        return ["description is required in SKILL.md YAML frontmatter"];
    return [];
}
function validateDescriptionWarnings(description) {
    const warnings = [];
    if (description.length > MAX_DESCRIPTION_LENGTH) {
        warnings.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
    }
    if (!DESCRIPTION_TRIGGER_PATTERN.test(description)) {
        warnings.push('description should include explicit trigger wording such as "Use this skill when" or "Use when"');
    }
    if (!DESCRIPTION_BOUNDARY_PATTERN.test(description)) {
        warnings.push('description should describe non-use boundaries, for example: "Do not use for backend-only, data-only, or pure documentation tasks."');
    }
    if (description.length < MIN_RECOMMENDED_DESCRIPTION_LENGTH) {
        warnings.push("description should be specific enough to guide model invocation; include task types, trigger phrases, and boundaries");
    }
    return warnings;
}
function parseFrontmatter(content) {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("---\n"))
        return { frontmatter: {}, body: normalized };
    const endIndex = normalized.indexOf("\n---", 4);
    if (endIndex === -1)
        return { frontmatter: {}, body: normalized };
    const yaml = normalized.slice(4, endIndex);
    const body = normalized.slice(endIndex + 4).trim();
    return { frontmatter: parseSimpleYamlFrontmatter(yaml), body };
}
function stripFrontmatter(content) {
    return parseFrontmatter(content).body;
}
function parseSimpleYamlFrontmatter(yaml) {
    const frontmatter = {};
    const lines = yaml.split("\n");
    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
        if (!match)
            continue;
        const key = match[1];
        const rawValue = match[2].trim();
        if (rawValue === "|" || rawValue === ">") {
            const collected = [];
            while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
                index++;
                collected.push(lines[index].trim());
            }
            assignFrontmatterValue(frontmatter, key, rawValue === ">" ? collected.join(" ") : collected.join("\n"));
            continue;
        }
        assignFrontmatterValue(frontmatter, key, parseScalar(rawValue));
    }
    return frontmatter;
}
function readOpenAiMetadata(skillDir, realRootDir, diagnostics) {
    const metadataPath = join(skillDir, ...OPENAI_AGENT_METADATA_PATH);
    if (!existsSync(metadataPath))
        return { allowImplicitInvocation: true };
    const stats = statSync(metadataPath);
    if (!stats.isFile() || stats.size > MAX_RESOURCE_BYTES) {
        return { allowImplicitInvocation: false };
    }
    const realSkillDir = realpathSync(skillDir);
    const realMetadataPath = realpathSync(metadataPath);
    assertInsideRealPath(realSkillDir, realMetadataPath, "Resolved OpenAI skill metadata path escapes skill root.");
    const content = readFileSync(realMetadataPath, "utf8");
    const policy = parseOpenAiImplicitPolicy(content);
    if (policy.error) {
        diagnostics.push({
            type: "error",
            message: policy.error,
            path: relativeToRoot(realRootDir, realMetadataPath),
        });
    }
    const interfaceMetadata = parseOpenAiInterfaceMetadata(content);
    return {
        allowImplicitInvocation: policy.value,
        ...(interfaceMetadata ? { interface: interfaceMetadata } : {}),
    };
}
function parseOpenAiImplicitPolicy(content) {
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim() || line.trimStart().startsWith("#"))
            continue;
        const section = line.match(/^(\s*)policy:\s*(.*)$/);
        if (!section)
            continue;
        if (section[2].trim()) {
            return { value: false, error: "policy.allow_implicit_invocation must be a boolean" };
        }
        const sectionIndent = section[1].length;
        for (let childIndex = index + 1; childIndex < lines.length; childIndex++) {
            const child = lines[childIndex];
            if (!child.trim() || child.trimStart().startsWith("#"))
                continue;
            if (leadingWhitespaceLength(child) <= sectionIndent)
                break;
            const match = child.match(/^\s+allow_implicit_invocation:\s*(.*)$/);
            if (!match)
                continue;
            if (match[1].trim() === "true")
                return { value: true };
            if (match[1].trim() === "false")
                return { value: false };
            return { value: false, error: "policy.allow_implicit_invocation must be a boolean" };
        }
        return { value: true };
    }
    return { value: true };
}
function parseOpenAiInterfaceMetadata(content) {
    const metadata = {};
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    let inInterfaceSection = false;
    let interfaceIndent = -1;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim() || line.trimStart().startsWith("#"))
            continue;
        const indent = leadingWhitespaceLength(line);
        if (!inInterfaceSection) {
            if (line.trim() === "interface:") {
                inInterfaceSection = true;
                interfaceIndent = indent;
            }
            continue;
        }
        if (indent <= interfaceIndent)
            break;
        const match = line.match(/^\s+([a-zA-Z0-9_-]+):\s*(.*)$/);
        if (!match)
            continue;
        const key = match[1];
        const rawValue = match[2].trim();
        if (rawValue === "|" || rawValue === ">") {
            const block = collectIndentedYamlBlock(lines, index, indent, rawValue === ">");
            index = block.nextIndex;
            assignOpenAiInterfaceValue(metadata, key, block.text);
            continue;
        }
        const value = parseScalar(rawValue);
        if (typeof value === "string") {
            assignOpenAiInterfaceValue(metadata, key, value);
        }
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
}
function collectIndentedYamlBlock(lines, startIndex, parentIndent, fold) {
    const collected = [];
    let index = startIndex;
    while (index + 1 < lines.length) {
        const nextLine = lines[index + 1];
        if (nextLine.trim() && leadingWhitespaceLength(nextLine) <= parentIndent)
            break;
        index++;
        collected.push(nextLine.trim());
    }
    return { text: fold ? collected.join(" ") : collected.join("\n"), nextIndex: index };
}
function assignOpenAiInterfaceValue(metadata, key, rawValue) {
    const value = clampMetadataValue(rawValue);
    if (!value)
        return;
    if (key === "display_name")
        metadata.displayName = value;
    if (key === "short_description")
        metadata.shortDescription = value;
    if (key === "default_prompt")
        metadata.defaultPrompt = value;
    if (key === "icon_small")
        metadata.iconSmall = value;
    if (key === "icon_large")
        metadata.iconLarge = value;
    if (key === "brand_color")
        metadata.brandColor = value;
}
function clampMetadataValue(value) {
    return value.trim().slice(0, MAX_INTERFACE_FIELD_LENGTH);
}
function leadingWhitespaceLength(value) {
    return value.length - value.trimStart().length;
}
function parseScalar(value) {
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function assignFrontmatterValue(frontmatter, key, value) {
    if (key === "name" && typeof value === "string")
        frontmatter.name = value;
    if (key === "description" && typeof value === "string")
        frontmatter.description = value;
}
function skillLocation(name, path) {
    return `skill://${encodeURIComponent(name)}/${toPosixPath(path)}`;
}
function relativeToRoot(root, path) {
    return toPosixPath(relative(root, path));
}
function toPosixPath(path) {
    return path.split(sep).join("/");
}
function assertInsideRealPath(root, target, message) {
    const normalizedRoot = normalizeCase(resolve(root));
    const normalizedTarget = normalizeCase(resolve(target));
    const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
    if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(prefix))
        throw new Error(message);
}
function normalizeCase(path) {
    return process.platform === "win32" ? path.toLowerCase() : path;
}
//# sourceMappingURL=workspace-skill-service.js.map