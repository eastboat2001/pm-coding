const DEFAULT_CONTRACTS = [
    {
        name: "file.list",
        allowedPhases: ["implementation", "repair", "validation", "delivery"],
        inputSchemaId: "agent-v2.file.list.input.v1",
        outputSchemaId: "agent-v2.file.list.output.v1",
        sideEffects: "none",
    },
    {
        name: "file.read",
        allowedPhases: ["implementation", "repair", "validation", "delivery"],
        inputSchemaId: "agent-v2.file.read.input.v1",
        outputSchemaId: "agent-v2.file.read.output.v1",
        sideEffects: "none",
    },
    {
        name: "file.write",
        allowedPhases: ["implementation", "repair"],
        inputSchemaId: "agent-v2.file.write.input.v1",
        outputSchemaId: "agent-v2.file.write.output.v1",
        sideEffects: "workspace_files",
    },
    {
        name: "file.patch",
        allowedPhases: ["implementation", "repair"],
        inputSchemaId: "agent-v2.file.patch.input.v1",
        outputSchemaId: "agent-v2.file.patch.output.v1",
        sideEffects: "workspace_files",
    },
    {
        name: "file.delete",
        allowedPhases: ["implementation", "repair"],
        inputSchemaId: "agent-v2.file.delete.input.v1",
        outputSchemaId: "agent-v2.file.delete.output.v1",
        sideEffects: "workspace_files",
    },
    {
        name: "validation.static_build",
        allowedPhases: ["validation", "repair"],
        inputSchemaId: "agent-v2.validation.static_build.input.v1",
        outputSchemaId: "agent-v2.validation.result.output.v1",
        sideEffects: "validation_records",
    },
    {
        name: "validation.static_quality",
        allowedPhases: ["validation", "repair"],
        inputSchemaId: "agent-v2.validation.static_quality.input.v1",
        outputSchemaId: "agent-v2.validation.result.output.v1",
        sideEffects: "validation_records",
    },
    {
        name: "validation.static_smoke",
        allowedPhases: ["validation", "repair"],
        inputSchemaId: "agent-v2.validation.static_smoke.input.v1",
        outputSchemaId: "agent-v2.validation.result.output.v1",
        sideEffects: "validation_records",
    },
    {
        name: "preview.publish",
        allowedPhases: ["preview", "delivery"],
        inputSchemaId: "agent-v2.preview.publish.input.v1",
        outputSchemaId: "agent-v2.preview.publish.output.v1",
        sideEffects: "preview_metadata",
    },
];
export function createAgentV2ToolRegistry(contracts = DEFAULT_CONTRACTS) {
    return new Map(contracts.map((contract) => [
        contract.name,
        {
            ...contract,
            allowedPhases: [...contract.allowedPhases],
        },
    ]));
}
export function assertAgentV2ToolAllowed(registry, toolName, phase) {
    const contract = registry.get(toolName);
    if (!contract) {
        throw new Error(`Agent v2 tool is not registered: ${toolName}`);
    }
    if (!contract.allowedPhases.includes(phase)) {
        throw new Error(`Agent v2 tool ${toolName} is not allowed during phase ${phase}`);
    }
    return contract;
}
export function createAgentV2ToolFailure(input) {
    return {
        code: input.code,
        message: input.message,
        retryable: input.retryable,
        ...(input.phase ? { phase: input.phase } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
        ...(input.path ? { path: input.path } : {}),
        data: input.data ?? {},
    };
}
//# sourceMappingURL=agent-v2-tool-governance.js.map