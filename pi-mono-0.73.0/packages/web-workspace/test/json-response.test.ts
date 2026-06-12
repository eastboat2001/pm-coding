import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { sendJson, sendPrettyJson } from "../src/json.js";

describe("JSON responses", () => {
	it("keeps default API JSON compact and supports pretty exported JSON", () => {
		const compact = createResponse();
		sendJson(compact.response, { runtime: { sessionId: "session-1" } });

		const pretty = createResponse();
		sendPrettyJson(pretty.response, { runtime: { sessionId: "session-1" } });

		expect(compact.body).toBe('{"runtime":{"sessionId":"session-1"}}');
		expect(pretty.body).toBe('{\n  "runtime": {\n    "sessionId": "session-1"\n  }\n}');
		expect(pretty.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
	});
});

function createResponse(): {
	body: string;
	headers: Map<string, string>;
	response: ServerResponse;
} {
	const result = {
		body: "",
		headers: new Map<string, string>(),
		response: undefined as unknown as ServerResponse,
	};
	result.response = {
		statusCode: 0,
		setHeader(name: string, value: string) {
			result.headers.set(name, value);
			return this;
		},
		end(chunk: string) {
			result.body = chunk;
			return this;
		},
	} as unknown as ServerResponse;
	return result;
}
