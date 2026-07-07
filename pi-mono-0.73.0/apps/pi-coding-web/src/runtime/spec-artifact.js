const MAX_OBJECTIVE_CHARS = 1200;
const MAX_REQUIREMENTS = 10;
const MAX_ATTACHMENT_REQUIREMENTS = 8;
export const SPEC_ARTIFACT_PROJECT_FILES = ["docs/spec.md", "docs/plan.md", "docs/tasks.md"];
export function buildSpecArtifact(input) {
    const source = extractSpecSource(input.messages);
    const objective = source.objective;
    const requirements = buildRequirements(source, input.capabilityPlan);
    const platformLimitations = buildPlatformLimitations(input.platform, input.capabilityPlan);
    const acceptanceCriteria = buildAcceptanceCriteria(input.capabilityPlan, objective);
    const qualityGates = ["project_task validate", "static_preview_quality_gate", "static_preview_smoke_gate"];
    return {
        schemaVersion: 1,
        objective,
        sourceDocuments: source.sourceDocuments,
        deliveryMode: input.capabilityPlan.deliveryMode,
        requirements,
        implementationPlan: buildImplementationPlan(input.capabilityPlan, source.sourceDocuments, qualityGates),
        taskChecklist: buildTaskChecklist(input.capabilityPlan, source.sourceDocuments),
        platformLimitations,
        acceptanceCriteria,
        qualityGates,
        nonGoals: buildNonGoals(input.capabilityPlan),
    };
}
export function formatSpecArtifactForPrompt(spec) {
    return [
        "",
        "",
        "Per-run implementation spec artifact:",
        "<spec_artifact>",
        `schema_version: ${spec.schemaVersion}`,
        `objective: ${spec.objective || "unknown"}`,
        `delivery_mode: ${spec.deliveryMode}`,
        formatList("source_documents", spec.sourceDocuments),
        formatRequirements(spec.requirements),
        formatList("implementation_plan", spec.implementationPlan),
        formatList("task_checklist", spec.taskChecklist),
        formatList("platform_limitations", spec.platformLimitations),
        formatList("acceptance_criteria", spec.acceptanceCriteria),
        formatList("quality_gates", spec.qualityGates),
        formatList("non_goals", spec.nonGoals),
        "</spec_artifact>",
    ].join("\n");
}
export function buildSpecExecutionContract(spec) {
    return {
        requiredReads: unique([...SPEC_ARTIFACT_PROJECT_FILES, ...spec.sourceDocuments]),
        requiredBeforeImplementation: true,
        readCommand: "project_file get",
    };
}
export function completedSpecExecutionReadsFromMessages(messages, contract) {
    const requiredReads = unique(contract.requiredReads.map(normalizeProjectPath).filter(Boolean));
    const requiredReadSet = new Set(requiredReads);
    const projectFileGetCalls = new Map();
    for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const block of message.content) {
            if (!isProjectFileGetToolCall(block)) continue;
            const filename = normalizeProjectPath(block.arguments.filename);
            if (!requiredReadSet.has(filename)) continue;
            projectFileGetCalls.set(block.id, filename);
        }
    }
    const completedReads = new Set();
    for (const message of messages) {
        if (message.role !== "toolResult") continue;
        const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
        const filename = projectFileGetCalls.get(toolCallId);
        if (!filename || message.isError === true) continue;
        completedReads.add(filename);
    }
    return requiredReads.filter((filename) => completedReads.has(filename));
}
export function formatSpecExecutionContractForPrompt(spec) {
    const contract = buildSpecExecutionContract(spec);
    return [
        "",
        "",
        "Per-run spec execution contract:",
        "<spec_execution_contract>",
        "Before creating or editing implementation files, call project_file get for every required read listed here.",
        `required_before_implementation: ${contract.requiredBeforeImplementation ? "true" : "false"}`,
        `read_command: ${contract.readCommand}`,
        formatList("required_reads", contract.requiredReads),
        "After reading them, implement from docs/spec.md, follow docs/plan.md, update behavior against docs/tasks.md, then validate.",
        "</spec_execution_contract>",
    ].join("\n");
}
export function specArtifactDiagnosticData(spec) {
    return {
        schemaVersion: spec.schemaVersion,
        objective: spec.objective,
        deliveryMode: spec.deliveryMode,
        sourceDocuments: spec.sourceDocuments,
        requirements: spec.requirements,
        implementationPlan: spec.implementationPlan,
        taskChecklist: spec.taskChecklist,
        platformLimitations: spec.platformLimitations,
        acceptanceCriteria: spec.acceptanceCriteria,
        qualityGates: spec.qualityGates,
        nonGoals: spec.nonGoals,
        executionContract: buildSpecExecutionContract(spec),
    };
}
export function parseSpecArtifactProjectFiles(files, fallback) {
    const filesByName = new Map(files.map((file) => [normalizeProjectPath(file.filename), file.content]));
    const specContent = filesByName.get("docs/spec.md");
    if (!specContent?.trim()) return fallback;
    const objective = parseLabeledLine(specContent, "Objective") || fallback.objective;
    const deliveryMode = parseDeliveryMode(parseLabeledLine(specContent, "Delivery mode")) ?? fallback.deliveryMode;
    const sourceDocuments = parseBulletSection(specContent, "Source Documents");
    const requirements = parseRequirementSection(specContent);
    const implementationPlan = parseBulletSection(filesByName.get("docs/plan.md") ?? "", "Plan");
    const taskChecklist = parseTaskChecklist(filesByName.get("docs/tasks.md") ?? "");
    const platformLimitations = parseBulletSection(specContent, "Platform Limitations");
    const acceptanceCriteria = parseBulletSection(specContent, "Acceptance Criteria");
    const qualityGates = parseBulletSection(specContent, "Quality Gates");
    const nonGoals = parseBulletSection(specContent, "Non Goals");
    return {
        schemaVersion: 1,
        objective,
        sourceDocuments: sourceDocuments.length > 0 ? sourceDocuments : fallback.sourceDocuments,
        deliveryMode,
        requirements: requirements.length > 0 ? requirements : fallback.requirements,
        implementationPlan: implementationPlan.length > 0 ? implementationPlan : fallback.implementationPlan,
        taskChecklist: taskChecklist.length > 0 ? taskChecklist : fallback.taskChecklist,
        platformLimitations: platformLimitations.length > 0 ? platformLimitations : fallback.platformLimitations,
        acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : fallback.acceptanceCriteria,
        qualityGates: qualityGates.length > 0 ? qualityGates : fallback.qualityGates,
        nonGoals: nonGoals.length > 0 ? nonGoals : fallback.nonGoals,
    };
}
function buildRequirements(source, capabilityPlan) {
    const texts = [
        ...requirementFragments(source.objective),
        ...source.attachmentRequirementFragments,
        ...sourceDocumentRequirements(source.sourceDocuments),
    ];
    const objective = source.objective;
    if (needsDeterministicFirstScreenData(objective)) {
        texts.push(
            "Render deterministic first-screen data for visible KPI cards, charts, tables, filters, and exports.",
        );
    }
    if (capabilityPlan.requiresSimulation) {
        texts.push(
            "Represent unsupported backend, database, auth, upload, job, or integration behavior only as static simulation.",
        );
    }
    return unique(texts)
        .slice(0, MAX_REQUIREMENTS)
        .map((text, index) => ({
            id: `REQ-${String(index + 1).padStart(3, "0")}`,
            kind: requirementKind(text),
            text,
        }));
}
function buildImplementationPlan(capabilityPlan, sourceDocuments, qualityGates) {
    const steps = [];
    if (sourceDocuments.length > 0) {
        steps.push(`Read source documents before implementation: ${sourceDocuments.join(", ")}.`);
    }
    steps.push("Derive the visible screens, data model, interactions, and export behavior from the spec requirements.");
    if (capabilityPlan.requiresSimulation) {
        steps.push(
            "Map unsupported runtime capabilities to explicit static simulation behavior and label any limitation honestly.",
        );
    }
    steps.push(
        "Implement deterministic first-screen data so KPI cards, charts, tables, and filters render immediately.",
    );
    steps.push(`Run and satisfy quality gates in order: ${qualityGates.join(", ")}.`);
    return steps;
}
function buildTaskChecklist(capabilityPlan, sourceDocuments) {
    const tasks = [
        "Read `docs/spec.md`, `docs/plan.md`, `docs/tasks.md`, and any listed source documents before editing app files.",
        "Implement the requested user-facing workflow with meaningful static data and domain terminology.",
        "Confirm first preview renders meaningful data without persistent loading states or `--` KPI values.",
        "Run `project_task validate` and fix every reported quality or smoke-gate issue.",
    ];
    if (sourceDocuments.length > 0) {
        tasks.splice(1, 0, `Trace implementation decisions back to source documents: ${sourceDocuments.join(", ")}.`);
    }
    if (capabilityPlan.requiresSimulation) {
        tasks.splice(
            tasks.length - 1,
            0,
            "Keep backend, database, auth, jobs, uploads, and external integrations as explicit static simulations only.",
        );
    }
    return tasks;
}
function buildPlatformLimitations(platform, capabilityPlan) {
    const limitations = [
        `Current adapter ${platform.adapterId} can serve static browser assets and static build output only.`,
    ];
    if (capabilityPlan.unsupportedCapabilities.length > 0) {
        limitations.push(
            `Current adapter ${platform.adapterId} cannot provide requested runtime capabilities: ${capabilityPlan.unsupportedCapabilities.join(", ")}.`,
        );
    }
    if (capabilityPlan.requiresSimulation) {
        limitations.push(
            "Static simulation may demonstrate UI flows and mock data, but it is not a real backend, database, auth, upload, scheduled job, or external integration runtime.",
        );
    }
    return limitations;
}
function buildAcceptanceCriteria(capabilityPlan, objective) {
    const criteria = [
        "The generated app must directly satisfy the latest user objective and preserve requested domain language.",
        "First preview must render meaningful first-screen data without persistent loading placeholders or `--` KPI values.",
        "Run project_task validate and fix all static preview quality and runtime smoke errors before the final response.",
    ];
    if (capabilityPlan.requiresSimulation) {
        criteria.push(
            "Final app and assistant response must not claim a real backend, database, server auth, upload, scheduled job, or external integration was created.",
        );
    }
    if (/\b(package\.json|vite|react|vue|svelte|build|dist)\b/i.test(objective)) {
        criteria.push("If a build-based frontend is used, run project_task build_static before project_task preview.");
    }
    return criteria;
}
function buildNonGoals(capabilityPlan) {
    if (!capabilityPlan.requiresSimulation) return [];
    return capabilityPlan.unsupportedCapabilities.map(
        (capability) => `Do not implement ${capability} as a claimed real runtime.`,
    );
}
function requirementKind(text) {
    if (/\b(api|backend|server|database|postgres|auth|login|upload|scheduled|integration)\b/i.test(text))
        return "platform";
    if (/\b(data|kpi|chart|table|csv|export|filter|dashboard|metric)\b/i.test(text)) return "data";
    if (/\b(validate|loading|placeholder|quality|smoke)\b/i.test(text)) return "quality";
    return "functional";
}
function requirementFragments(objective) {
    return objective
        .split(/(?:\r?\n|[.;])/)
        .map((part) => normalizeWhitespace(part))
        .filter(isUsefulRequirementFragment);
}
function needsDeterministicFirstScreenData(objective) {
    return /\b(dashboard|kpi|chart|table|metric|csv|export|filter|report|analytics|quality|operation)\b/i.test(
        objective,
    );
}
function extractSpecSource(messages) {
    const latestText = latestUserText(messages);
    const sourceDocuments = sourceDocumentPaths(messages, latestText);
    const objective = inferObjective(latestText);
    return {
        objective,
        sourceDocuments,
        attachmentRequirementFragments: attachmentRequirementFragments(messages),
    };
}
function latestUserText(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const role = message.role;
        if (role !== "user" && role !== "user-with-attachments") continue;
        const text = messageText(message).trim();
        if (text) return text;
    }
    return "";
}
function inferObjective(text) {
    const markedObjective = firstMarkedValue(text, [
        "Session title",
        "Project title",
        "Objective",
        "Goal",
        "Task",
        "User request",
    ]);
    if (markedObjective) return truncateText(markedObjective, MAX_OBJECTIVE_CHARS);
    const meaningfulLine = text
        .split(/\r?\n/)
        .map((line) => normalizeWhitespace(line))
        .find((line) => line && !isWrapperLine(line) && !isDocumentPathLine(line));
    if (meaningfulLine) return truncateText(meaningfulLine, MAX_OBJECTIVE_CHARS);
    return truncateText(normalizeWhitespace(text), MAX_OBJECTIVE_CHARS);
}
function firstMarkedValue(text, labels) {
    const labelPattern = labels.map(escapeRegExp).join("|");
    const regex = new RegExp(
        `^\\s*(?:[-*]\\s*)?(?:\\d+\\.\\s*)?(?:#+\\s*)?(?:${labelPattern})\\s*[:：]\\s*(.+?)\\s*$`,
        "im",
    );
    const match = regex.exec(text);
    if (!match?.[1]) return "";
    return cleanMarkedValue(match[1]);
}
function cleanMarkedValue(value) {
    return normalizeWhitespace(
        value.split(/\b(?:Read these files|Execution rules|Implementation rules|Source documents?)\b/i)[0] ?? value,
    ).replace(/\s*(?:\.{3,}|…)\s*$/, "");
}
function sourceDocumentPaths(messages, latestText) {
    const paths = [];
    for (const message of messages) {
        const attachments = message.attachments;
        if (!Array.isArray(attachments)) continue;
        for (const attachment of attachments) {
            if (typeof attachment.projectFilePath === "string" && attachment.projectFilePath.trim()) {
                paths.push(attachment.projectFilePath.trim());
            }
        }
    }
    paths.push(...sourceDocumentPathsFromText(latestText));
    return unique(paths);
}
function sourceDocumentPathsFromText(text) {
    const matches = text.matchAll(
        /\b(?:docs|attachments)\/[^\r\n`'"<>]*?\.(?:md|mdx|txt|csv|json|yaml|yml|html|css|js|ts|tsx)\b/gi,
    );
    return [...matches].map((match) => normalizeWhitespace(match[0]));
}
function attachmentRequirementFragments(messages) {
    const fragments = [];
    for (const message of messages) {
        const attachments = message.attachments;
        if (!Array.isArray(attachments)) continue;
        for (const attachment of attachments) {
            if (typeof attachment.extractedText !== "string") continue;
            fragments.push(...documentRequirementFragments(attachment.extractedText));
            if (fragments.length >= MAX_ATTACHMENT_REQUIREMENTS)
                return unique(fragments).slice(0, MAX_ATTACHMENT_REQUIREMENTS);
        }
    }
    return unique(fragments).slice(0, MAX_ATTACHMENT_REQUIREMENTS);
}
function documentRequirementFragments(text) {
    return text
        .split(/\r?\n/)
        .map((line) => cleanMarkdownRequirementLine(line))
        .filter(isUsefulRequirementFragment)
        .slice(0, MAX_ATTACHMENT_REQUIREMENTS);
}
function cleanMarkdownRequirementLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---" || /^\|?\s*:?-{3,}/.test(trimmed) || trimmed.includes(" | ")) return "";
    return normalizeWhitespace(
        trimmed
            .replace(/^>\s*/, "")
            .replace(/^#+\s*/, "")
            .replace(/^(?:[-*]|\d+\.)\s+/, "")
            .replace(/\*\*/g, "")
            .replace(/`/g, ""),
    );
}
function sourceDocumentRequirements(sourceDocuments) {
    if (sourceDocuments.length === 0) return [];
    return [`Read and follow source documents before implementation: ${sourceDocuments.join(", ")}.`];
}
function messageText(message) {
    if (!message) return "";
    const record = message;
    return [contentText(record.llmContent), contentText(record.content)].filter(Boolean).join("\n");
}
function contentText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((item) => {
            if (typeof item === "string") return item;
            if (!item || typeof item !== "object") return "";
            const record = item;
            return record.type === "text" && typeof record.text === "string" ? record.text : "";
        })
        .filter(Boolean)
        .join("\n");
}
function parseLabeledLine(content, label) {
    const match = new RegExp(`^\\s*${escapeRegExp(label)}\\s*[:：]\\s*(.+?)\\s*$`, "im").exec(content);
    return normalizeWhitespace(match?.[1] ?? "");
}
function parseDeliveryMode(value) {
    if (value === "static_app" ||
        value === "static_simulation" ||
        value === "build_static_frontend" ||
        value === "full_stack" ||
        value === "unsupported" ||
        value === "needs_clarification") {
        return value;
    }
    return undefined;
}
function parseRequirementSection(content) {
    return parseBulletSection(content, "Requirements")
        .map((item) => {
            const match = /^REQ-(\d+)\s+\[(functional|data|platform|quality)]\s+(.+)$/.exec(item);
            if (!match) return undefined;
            return {
                id: `REQ-${match[1].padStart(3, "0")}`,
                kind: match[2],
                text: normalizeWhitespace(match[3]),
            };
        })
        .filter((item) => item !== undefined);
}
function parseTaskChecklist(content) {
    return parseBulletSection(content, "Tasks").map((item) => normalizeWhitespace(item.replace(/^\[[ xX]]\s*/, "")));
}
function parseBulletSection(content, heading) {
    const section = sectionContent(content, heading);
    if (!section) return [];
    const values = [];
    for (const line of section.split(/\r?\n/)) {
        const match = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        const value = normalizeWhitespace(match[1]);
        if (value && value.toLowerCase() !== "none") values.push(value);
    }
    return values;
}
function sectionContent(content, heading) {
    const headingRegex = new RegExp(`^\\s*#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, "im");
    const match = headingRegex.exec(content);
    if (!match) return "";
    const start = match.index + match[0].length;
    const rest = content.slice(start);
    const nextHeading = /^\s*#{1,6}\s+/m.exec(rest);
    return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}
function formatRequirements(requirements) {
    if (requirements.length === 0) return "requirements: none";
    return ["requirements:", ...requirements.map((item) => `- ${item.id} [${item.kind}] ${item.text}`)].join("\n");
}
function formatList(label, values) {
    if (values.length === 0) return `${label}: none`;
    return [`${label}:`, ...values.map((value) => `- ${value}`)].join("\n");
}
function isProjectFileGetToolCall(value) {
    if (!value || typeof value !== "object") return false;
    const block = value;
    return (
        block.type === "toolCall" &&
        typeof block.id === "string" &&
        block.name === "project_file" &&
        block.arguments?.command === "get" &&
        typeof block.arguments.filename === "string"
    );
}
function normalizeProjectPath(value) {
    return value
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/\/+/g, "/")
        .trim();
}
function normalizeWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
function isUsefulRequirementFragment(value) {
    if (!value) return false;
    if (value.length < 8) return false;
    if (/^\d+\.?$/.test(value)) return false;
    if (/^md\s+\d+$/i.test(value)) return false;
    if (isDocumentMetadataLine(value)) return false;
    if (isWrapperLine(value)) return false;
    if (isDocumentPathLine(value)) return false;
    return true;
}
function isWrapperLine(value) {
    return /^(?:[-*]\s*)?(?:\d+\.\s*)?(?:you are a senior|read these files|execution rules|implementation rules|implementation requirements|quality gates|suggested work sequence|output expectations|do not summarize|run validation before final response|prd document\s*[:：]|system design document\s*[:：]|project context\s*[:：]|session id\s*[:：]|session title\s*[:：]|project title\s*[:：]|files mentioned by the user)/i.test(
        value,
    );
}
function isDocumentMetadataLine(value) {
    return /^(?:basic document information|system design document|this design draft is assembled\b.*|missing or unconfirmed information\b.*|collection coverage\b.*|field\s*\|?\s*value|template name|document name|system \/ module|initiating department|author \/ requester|version|creation date|business domain|status|target release|(?:\d+(?:\.\d+)*\s+)?background(?: and objectives)?|(?:\d+(?:\.\d+)*\s+)?objectives|(?:\d+(?:\.\d+)*\s+)?page \/ function presentation|(?:\d+(?:\.\d+)*\s+)?scope and objectives)$/i.test(
        value,
    );
}
function isDocumentPathLine(value) {
    return /^(?:\d+\.\s*)?(?:docs|attachments)\//i.test(value);
}
function truncateText(value, maxChars) {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trimEnd()}…`;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function unique(values) {
    return [...new Set(values)];
}
