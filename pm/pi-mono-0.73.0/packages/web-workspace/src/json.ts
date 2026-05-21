import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { JsonObject } from "./types.js";

export function readJsonFile(path: string): JsonObject {
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (!isObject(value)) throw new Error(`JSON file is not an object: ${path}`);
	return value;
}

export function writeJsonFile(path: string, payload: JsonObject): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
	renameSync(tempPath, path);
}

export function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
	return new Promise((resolveBody, rejectBody) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > 20 * 1024 * 1024) rejectBody(new Error("Request body too large."));
		});
		req.on("end", () => {
			if (!body.trim()) {
				resolveBody({});
				return;
			}
			try {
				const value = JSON.parse(body);
				if (!isObject(value)) throw new Error("JSON body must be an object.");
				resolveBody(value);
			} catch (error) {
				rejectBody(error);
			}
		});
		req.on("error", rejectBody);
	});
}

export function sendJson(res: ServerResponse, payload: JsonObject, status = 200): void {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

export function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneJsonObject(value: JsonObject): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}
