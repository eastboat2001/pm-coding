import { PostgresRuntimeStore } from "./postgres-runtime-store.js";
import { RuntimeDbStore } from "./runtime-db.js";
import type { RuntimeStore } from "./runtime-store.js";

export type RuntimeStoreConfig = {
	runtimeStore: "postgres" | "sqlite";
	postgresUrl: string;
	runtimeDbFile: string;
};

export function createRuntimeStore(config: RuntimeStoreConfig): RuntimeStore {
	if (config.runtimeStore === "sqlite") {
		return new RuntimeDbStore(config.runtimeDbFile);
	}
	return new PostgresRuntimeStore({ url: config.postgresUrl });
}
