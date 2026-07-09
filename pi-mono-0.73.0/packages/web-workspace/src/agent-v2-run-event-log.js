export class AgentV2RunEventLog {
    constructor(options) {
        this.store = options.store;
        this.bus = options.bus;
    }
    async append(input) {
        const event = await this.store.appendAgentV2RunEvent(input);
        await this.bus.publish(event);
        return event;
    }
    async list(clientId, runId, afterSeq) {
        return await this.store.listAgentV2RunEvents(clientId, runId, afterSeq);
    }
    async readLive(request) {
        const durableEvents = await this.list(request.clientId, request.runId, request.afterSeq);
        if (durableEvents.length > 0) {
            return durableEvents;
        }
        return await this.bus.read(request);
    }
}
//# sourceMappingURL=agent-v2-run-event-log.js.map