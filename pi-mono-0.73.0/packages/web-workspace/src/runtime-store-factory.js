import { PostgresRuntimeStore } from "./postgres-runtime-store.js";
import { RuntimeDbStore } from "./runtime-db.js";
export function createAgentV2RuntimeStore(config) {
    return config.runtimeStore === "postgres"
        ? new PostgresRuntimeStore({ url: config.postgresUrl })
        : new RuntimeDbStore(config.runtimeDbFile);
}
//# sourceMappingURL=runtime-store-factory.js.map