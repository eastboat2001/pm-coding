import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import type { RunStatus, RuntimeRunEventRecord } from "@mariozechner/pi-web-workspace";

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["cancelled", "completed", "failed", "interrupted"]);
type MutableRemoteState = {
	errorMessage?: string;
	pendingToolCalls: ReadonlySet<string>;
	streamingMessage?: unknown;
};

export class RemoteAgentController {
	private _activeRunId: string | undefined;
	private _lastSeq = 0;
	private agentEndApplied = false;

	constructor(private readonly agent: Agent) {}

	startRemoteRun(runId: string): void {
		if (!runId.trim()) {
			throw new Error("Remote run id is required.");
		}
		if (this._activeRunId) {
			throw new Error(`Remote run ${this._activeRunId} is already active.`);
		}

		this.agent.beginRemoteRun();
		this._activeRunId = runId;
		this._lastSeq = 0;
		this.agentEndApplied = false;
	}

	async applyRunEvent(event: RuntimeRunEventRecord): Promise<void> {
		if (!this._activeRunId) {
			throw new Error("startRemoteRun() must be called before applyRunEvent().");
		}
		if (event.runId !== this._activeRunId) {
			throw new Error(`Remote run event ${event.runId} does not match active run ${this._activeRunId}.`);
		}

		const payload = event.payload as AgentEvent;
		if (this.isLocalPromptEcho(payload)) {
			this._lastSeq = Math.max(this._lastSeq, event.seq);
			return;
		}

		await this.agent.applyRemoteEvent(payload);
		this._lastSeq = Math.max(this._lastSeq, event.seq);
		if (payload.type === "agent_end") {
			this.agentEndApplied = true;
		}
	}

	hydrateRunEvents(events: RuntimeRunEventRecord[]): void {
		if (!this._activeRunId) {
			throw new Error("startRemoteRun() must be called before hydrateRunEvents().");
		}

		for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
			if (event.runId !== this._activeRunId) {
				throw new Error(`Remote run event ${event.runId} does not match active run ${this._activeRunId}.`);
			}
			const payload = event.payload as AgentEvent;
			this.hydrateAgentEvent(payload);
			this._lastSeq = Math.max(this._lastSeq, event.seq);
			if (payload.type === "agent_end") {
				this.agentEndApplied = true;
			}
		}
	}

	async finishRemoteRun(status: RunStatus): Promise<void> {
		if (!this._activeRunId) throw new Error("No active remote run to finish.");
		if (!TERMINAL_RUN_STATUSES.has(status)) throw new Error(`Remote run status ${status} is not terminal.`);
		if (!this.agentEndApplied) throw new Error("Remote run cannot finish before an agent_end event.");

		await this.agent.endRemoteRun();
		this._activeRunId = undefined;
		this.agentEndApplied = false;
	}

	async settleRemoteRun(status: RunStatus): Promise<void> {
		if (!this._activeRunId) throw new Error("No active remote run to settle.");
		if (!TERMINAL_RUN_STATUSES.has(status)) throw new Error(`Remote run status ${status} is not terminal.`);
		if (!this.agentEndApplied) {
			await this.applyRunEvent({
				eventId: 0,
				runId: this._activeRunId,
				sessionId: "",
				clientId: "",
				seq: this._lastSeq,
				type: "agent_end",
				payload: { type: "agent_end", messages: [] },
				createdAt: new Date().toISOString(),
			});
		}
		await this.finishRemoteRun(status);
	}

	get activeRunId(): string | undefined {
		return this._activeRunId;
	}

	get lastSeq(): number {
		return this._lastSeq;
	}

	private isLocalPromptEcho(event: AgentEvent): boolean {
		if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") {
			return false;
		}

		const message = event.message as { role?: unknown };
		if (message.role !== "user" && message.role !== "user-with-attachments") {
			return false;
		}

		const eventMessageKey = messageKey(message);
		return this.agent.state.messages.some((existingMessage) => messageKey(existingMessage) === eventMessageKey);
	}

	private hydrateAgentEvent(event: AgentEvent): void {
		if (this.isLocalPromptEcho(event)) return;

		const state = this.agent.state as unknown as MutableRemoteState;
		switch (event.type) {
			case "message_start":
			case "message_update":
				state.streamingMessage = event.message;
				break;
			case "message_end":
				state.streamingMessage = undefined;
				if (
					!this.agent.state.messages.some(
						(existingMessage) => messageKey(existingMessage) === messageKey(event.message),
					)
				) {
					this.agent.state.messages = [...this.agent.state.messages, event.message];
				}
				break;
			case "tool_execution_start":
				state.pendingToolCalls = new Set([...state.pendingToolCalls, event.toolCallId]);
				break;
			case "tool_execution_end": {
				const pendingToolCalls = new Set(state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				state.pendingToolCalls = pendingToolCalls;
				break;
			}
			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					state.errorMessage = event.message.errorMessage;
				}
				break;
			case "agent_end":
				state.streamingMessage = undefined;
				break;
		}
	}
}

function messageKey(message: unknown): string {
	return JSON.stringify(message);
}
