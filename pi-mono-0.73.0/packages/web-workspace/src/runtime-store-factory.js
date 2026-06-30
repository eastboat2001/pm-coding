import { PostgresRuntimeStore } from "./postgres-runtime-store.js";
import { RuntimeDbStore } from "./runtime-db.js";
export function createRuntimeStore(config) {
    if (config.runtimeStore === "sqlite") {
        return new RuntimeDbStore(config.runtimeDbFile);
    }
    return new PostgresRuntimeStore({ url: config.postgresUrl });
}
//# sourceMappingURL=runtime-store-factory.js.map