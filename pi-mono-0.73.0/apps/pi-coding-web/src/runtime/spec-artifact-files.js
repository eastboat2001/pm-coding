export function specArtifactProjectFileSeeds(spec) {
    return [
        { filename: "docs/spec.md", content: renderSpecMarkdown(spec) },
        { filename: "docs/plan.md", content: renderPlanMarkdown(spec) },
        { filename: "docs/tasks.md", content: renderTasksMarkdown(spec) },
    ];
}
export function mergeProjectFileSeeds(files) {
    const merged = [];
    const seen = new Set();
    for (const file of files) {
        const filename = file.filename.trim();
        if (!filename)
            continue;
        const key = filename.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        merged.push({ ...file, filename });
    }
    return merged;
}
function renderSpecMarkdown(spec) {
    return [
        "# Specification",
        "",
        `Objective: ${spec.objective || "Unknown"}`,
        `Delivery mode: ${spec.deliveryMode}`,
        "",
        renderListSection("Source Documents", spec.sourceDocuments),
        renderRequirementSection(spec.requirements),
        renderListSection("Platform Limitations", spec.platformLimitations),
        renderListSection("Acceptance Criteria", spec.acceptanceCriteria),
        renderListSection("Quality Gates", spec.qualityGates),
        renderListSection("Non Goals", spec.nonGoals),
        "",
    ].join("\n");
}
function renderPlanMarkdown(spec) {
    return [
        "# Implementation Plan",
        "",
        `Objective: ${spec.objective || "Unknown"}`,
        `Delivery mode: ${spec.deliveryMode}`,
        "",
        renderListSection("Source Documents", spec.sourceDocuments),
        renderListSection("Plan", spec.implementationPlan),
        renderListSection("Validation", spec.qualityGates.map((gate) => `Run ${gate}.`)),
        "",
    ].join("\n");
}
function renderTasksMarkdown(spec) {
    const tasks = spec.taskChecklist.filter(Boolean);
    return ["# Tasks", "", ...tasks.map((task) => `- [ ] ${task}`), ""].join("\n");
}
function renderRequirementSection(requirements) {
    if (requirements.length === 0)
        return renderListSection("Requirements", []);
    return [
        "## Requirements",
        "",
        ...requirements.map((item) => `- ${item.id} [${item.kind}] ${item.text}`),
        "",
    ].join("\n");
}
function renderListSection(title, values) {
    if (values.length === 0)
        return [`## ${title}`, "", "- None", ""].join("\n");
    return [`## ${title}`, "", ...values.map((value) => `- ${value}`), ""].join("\n");
}
