import type { AgentV2DurableCommitStore } from "./agent-v2-durable-store.js";
import type { AgentV2OutboxStore } from "./agent-v2-outbox.js";
import type {
	AgentV2DiagnosticExportStore,
	AgentV2ExecutionStore,
	AgentV2ResetStore,
	AgentV2RunApiStore,
	AgentV2RunEventLogStore,
	AgentV2SchemaStore,
	AgentV2WorkerStore,
} from "./agent-v2-runtime-store.js";
import { PostgresRuntimeStore } from "./postgres-runtime-store.js";
import { RuntimeDbStore } from "./runtime-db.js";
import type { StorageConfig } from "./types.js";

export type AgentV2ProductionStore = AgentV2SchemaStore &
	AgentV2RunApiStore &
	AgentV2WorkerStore &
	AgentV2RunEventLogStore &
	AgentV2DiagnosticExportStore &
	AgentV2ExecutionStore &
	AgentV2ResetStore &
	AgentV2DurableCommitStore &
	AgentV2OutboxStore & {
		close(): void | Promise<void>;
	};

export function createAgentV2RuntimeStore(config: StorageConfig): AgentV2ProductionStore {
	return config.runtimeStore === "postgres"
		? new PostgresRuntimeStore({ url: config.postgresUrl })
		: new RuntimeDbStore(config.runtimeDbFile);
}
