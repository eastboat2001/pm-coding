export class AgentV2RunEventLog {
    store;
    constructor(options) {
        this.store = options.store;
    }
    async append(input) {
        return await this.store.appendAgentV2RunEvent(input);
    }
    async list(clientId, runId, afterSeq) {
        return await this.store.listAgentV2RunEvents(clientId, runId, afterSeq);
    }
}
//# sourceMappingURL=agent-v2-run-event-log.js.map