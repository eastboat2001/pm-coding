import { describe, expect, it } from "vitest";
import { formatModelTokenCount } from "../src/dialogs/ModelSelector.js";

describe("model selector token formatting", () => {
	it("does not append K to raw token counts or M-formatted counts", () => {
		expect(formatModelTokenCount(512)).toBe("512");
		expect(formatModelTokenCount(128000)).toBe("128K");
		expect(formatModelTokenCount(1000000)).toBe("1M");
	});
});
