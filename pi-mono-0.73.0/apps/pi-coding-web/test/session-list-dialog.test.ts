import { describe, expect, it } from "vitest";
import { isCancellableRunStatus, sessionRunStatusLabel } from "../src/dialogs/LocalSessionListDialog.js";

describe("session run status labels", () => {
	it("labels active statuses", () => {
		expect(sessionRunStatusLabel("queued")).toBe("Queued");
		expect(sessionRunStatusLabel("running")).toBe("Running");
		expect(sessionRunStatusLabel("cancelling")).toBe("Cancelling");
	});

	it("labels terminal statuses", () => {
		expect(sessionRunStatusLabel("failed")).toBe("Failed");
		expect(sessionRunStatusLabel("cancelled")).toBe("Cancelled");
		expect(sessionRunStatusLabel("interrupted")).toBe("Interrupted");
		expect(sessionRunStatusLabel(undefined)).toBe("");
	});

	it("only shows the cancel control for runs that can still be cancelled", () => {
		expect(isCancellableRunStatus("queued")).toBe(true);
		expect(isCancellableRunStatus("running")).toBe(true);
		expect(isCancellableRunStatus("cancelling")).toBe(false);
		expect(isCancellableRunStatus("cancelled")).toBe(false);
		expect(isCancellableRunStatus(undefined)).toBe(false);
	});
});
