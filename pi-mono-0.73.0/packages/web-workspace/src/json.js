import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export function readJsonFile(path) {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(value))
        throw new Error(`JSON file is not an object: ${path}`);
    return value;
}
export function writeJsonFile(path, payload) {
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tempPath, path);
}
export function readJsonBody(req) {
    return new Promise((resolveBody, rejectBody) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 20 * 1024 * 1024)
                rejectBody(new Error("Request body too large."));
        });
        req.on("end", () => {
            if (!body.trim()) {
                resolveBody({});
                return;
            }
            try {
                const value = JSON.parse(body);
                if (!isObject(value))
                    throw new Error("JSON body must be an object.");
                resolveBody(value);
            }
            catch (error) {
                rejectBody(error);
            }
        });
        req.on("error", rejectBody);
    });
}
export function sendJson(res, payload, status = 200) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
}
export function sendPrettyJson(res, payload, status = 200) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload, null, 2));
}
export function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function cloneJsonObject(value) {
    return JSON.parse(JSON.stringify(value));
}
//# sourceMappingURL=json.js.map