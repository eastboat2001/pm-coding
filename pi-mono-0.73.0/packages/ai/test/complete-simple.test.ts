import { afterEach, describe, expect, it } from "vitest";
import { completeSimple } from "../src/complete-simple.js";
import { fauxAssistantMessage, registerFauxProvider } from "../src/providers/faux.js";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("completeSimple worker facade", () => {
	it("dynamically loads the stream registry and forwards a faux completion without network access", async () => {
		const registration = registerFauxProvider({ api: "phase10-faux", provider: "phase10-faux" });
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("facade-ok")]);

		const response = await completeSimple(registration.getModel(), {
			messages: [{ role: "user", content: "test", timestamp: Date.now() }],
		});

		expect(response.content).toEqual([{ type: "text", text: "facade-ok" }]);
		expect(registration.state.callCount).toBe(1);
	});
});
