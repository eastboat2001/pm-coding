import { describe, expect, it } from "vitest";
import { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import type { AgentV2RunEventRecord, AppendAgentV2RunEventInput } from "../src/agent-v2-store.js";

const identity = {
	clientId: "client-a",
	runId: "run-a",
};

function event(seq: number, type = "agent_v2.phase_changed"): AgentV2RunEventRecord {
	return {
		...identity,
		seq,
		type,
		payload: { seq, type },
		createdAt: `2026-07-08T00:00:0${seq}.000Z`,
	};
}

describe("AgentV2RunEventLog", () => {
	it("appends only to the durable store and never projects synchronously", async () => {
		const store = new RecordingStore();
		const log = new AgentV2RunEventLog({ store });

		const appended = await log.append({
			clientId: "client-a",
			runId: "run-a",
			type: "agent_v2.phase_changed",
			payload: { phase: "implementation" },
			createdAt: "2026-07-08T00:01:00.000Z",
		});

		expect(store.appendCalls).toEqual([
			{
				clientId: "client-a",
				runId: "run-a",
				type: "agent_v2.phase_changed",
				payload: { phase: "implementation" },
				createdAt: "2026-07-08T00:01:00.000Z",
			},
		]);
		expect(appended.seq).toBe(1);
	});

	it("lists canonical durable events after the requested sequence", async () => {
		const store = new RecordingStore([event(2), event(3)]);
		const log = new AgentV2RunEventLog({ store });

		await expect(log.list(identity.clientId, identity.runId, 1)).resolves.toEqual([event(2), event(3)]);
		expect(store.listCalls).toEqual([{ ...identity, afterSeq: 1 }]);
	});
});

class RecordingStore {
	readonly appendCalls: AppendAgentV2RunEventInput[] = [];
	readonly listCalls: Array<{ clientId: string; runId: string; afterSeq: number }> = [];
	private nextSeq = 1;

	constructor(private readonly listResult: AgentV2RunEventRecord[] = []) {}

	async appendAgentV2RunEvent(input: AppendAgentV2RunEventInput): Promise<AgentV2RunEventRecord> {
		this.appendCalls.push(input);
		return {
			clientId: input.clientId,
			runId: input.runId,
			seq: input.seq ?? this.nextSeq++,
			type: input.type,
			payload: input.payload,
			createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		};
	}

	async listAgentV2RunEvents(clientId: string, runId: string, afterSeq: number): Promise<AgentV2RunEventRecord[]> {
		this.listCalls.push({ clientId, runId, afterSeq });
		return this.listResult.filter((entry) => entry.seq > afterSeq);
	}
}
