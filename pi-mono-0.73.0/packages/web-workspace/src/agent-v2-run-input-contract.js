export class AgentV2RunInputContractError extends Error {
    constructor(message = "Agent v2 run input must include non-empty string sessionId and title fields.") {
        super(message);
        this.name = "AgentV2RunInputContractError";
    }
}
export function parseAgentV2RunContext(input) {
    if (!isRecord(input))
        throw new AgentV2RunInputContractError();
    const sessionId = nonEmptyInputString(input.sessionId);
    const title = nonEmptyInputString(input.title);
    if (!sessionId || !title)
        throw new AgentV2RunInputContractError();
    return { sessionId, title };
}
export function validateAgentV2RunInput(input) {
    const context = parseAgentV2RunContext(input);
    return { ...input, ...context };
}
function nonEmptyInputString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=agent-v2-run-input-contract.js.map