import { describe, expect, it } from "vitest";
import {
	createWorkspaceExpansionState,
	reduceWorkspaceExpansion,
} from "../src/app/workspace-expansion-coordinator.js";

describe("workspace expansion coordinator", () => {
	it("allows desktop sidebar and run details to coexist", () => {
		let state = createWorkspaceExpansionState("desktop");
		state = reduceWorkspaceExpansion(state, { type: "open_sidebar", sidebar: "files" });
		state = reduceWorkspaceExpansion(state, { type: "open_active_run_detail" });
		state = reduceWorkspaceExpansion(state, { type: "open_historical_run_detail", runId: "run-old" });

		expect(state).toMatchObject({
			viewport: "desktop",
			sidebar: "files",
			activeRunDetailOpen: true,
			historicalRunDetailId: "run-old",
		});
	});

	it("enforces compact mutual exclusion and normalizes a desktop state when the viewport shrinks", () => {
		let state = createWorkspaceExpansionState("compact");
		state = reduceWorkspaceExpansion(state, { type: "open_sidebar", sidebar: "apps" });
		state = reduceWorkspaceExpansion(state, { type: "open_active_run_detail" });
		expect(state).toMatchObject({ sidebar: null, activeRunDetailOpen: true });

		state = reduceWorkspaceExpansion(state, { type: "open_sidebar", sidebar: "files" });
		expect(state).toMatchObject({
			sidebar: "files",
			activeRunDetailOpen: false,
			historicalRunDetailId: null,
		});

		let desktop = createWorkspaceExpansionState("desktop");
		desktop = reduceWorkspaceExpansion(desktop, { type: "open_sidebar", sidebar: "apps" });
		desktop = reduceWorkspaceExpansion(desktop, { type: "open_historical_run_detail", runId: "run-old" });
		desktop = reduceWorkspaceExpansion(desktop, { type: "set_viewport", viewport: "compact" });
		expect(desktop).toMatchObject({ sidebar: null, historicalRunDetailId: "run-old" });
	});

	it("keeps compact sidebars, file previews, active details, and historical details mutually exclusive", () => {
		let state = createWorkspaceExpansionState("compact");
		state = reduceWorkspaceExpansion(state, { type: "open_sidebar", sidebar: "files" });
		state = reduceWorkspaceExpansion(state, { type: "open_file_preview", path: "src/main.ts" });
		expect(state).toMatchObject({ sidebar: null, filePreviewPath: "src/main.ts" });

		state = reduceWorkspaceExpansion(state, { type: "open_active_run_detail" });
		expect(state).toMatchObject({ filePreviewPath: null, activeRunDetailOpen: true, historicalRunDetailId: null });

		state = reduceWorkspaceExpansion(state, { type: "open_historical_run_detail", runId: "run-old" });
		expect(state).toMatchObject({ activeRunDetailOpen: false, historicalRunDetailId: "run-old" });

		state = reduceWorkspaceExpansion(state, { type: "open_sidebar", sidebar: "apps" });
		expect(state).toMatchObject({
			sidebar: "apps",
			filePreviewPath: null,
			activeRunDetailOpen: false,
			historicalRunDetailId: null,
		});
	});

	it("keeps at most one historical detail and one internal section", () => {
		let state = createWorkspaceExpansionState("desktop");
		state = reduceWorkspaceExpansion(state, { type: "open_historical_run_detail", runId: "run-1" });
		state = reduceWorkspaceExpansion(state, { type: "open_historical_run_detail", runId: "run-2" });
		state = reduceWorkspaceExpansion(state, { type: "open_internal_section", section: "artifacts" });
		state = reduceWorkspaceExpansion(state, { type: "open_internal_section", section: "validation" });

		expect(state.historicalRunDetailId).toBe("run-2");
		expect(state.internalSection).toBe("validation");
	});

	it("tracks file preview independently and Settings preserves the underlying expansion state", () => {
		let state = createWorkspaceExpansionState("desktop");
		state = reduceWorkspaceExpansion(state, { type: "open_sidebar", sidebar: "files" });
		state = reduceWorkspaceExpansion(state, { type: "open_file_preview", path: "src/main.ts" });
		state = reduceWorkspaceExpansion(state, { type: "open_active_run_detail" });
		const underlying = state;
		state = reduceWorkspaceExpansion(state, { type: "open_settings" });

		expect(state).toMatchObject({
			settingsModalOpen: true,
			sidebar: "files",
			filePreviewPath: "src/main.ts",
			activeRunDetailOpen: true,
		});
		state = reduceWorkspaceExpansion(state, { type: "close_settings" });
		expect(state).toEqual(underlying);
	});

	it("does not auto-open replayed errors after their fingerprints were dismissed", () => {
		let state = createWorkspaceExpansionState("desktop");
		state = reduceWorkspaceExpansion(state, {
			type: "error_observed",
			fingerprint: "error-1",
			replayed: false,
		});
		expect(state.internalSection).toBe("errors");
		state = reduceWorkspaceExpansion(state, { type: "dismiss_error", fingerprint: "error-1" });
		state = reduceWorkspaceExpansion(state, { type: "close_internal_section" });
		state = reduceWorkspaceExpansion(state, {
			type: "error_observed",
			fingerprint: "error-1",
			replayed: true,
		});

		expect(state.internalSection).toBeNull();
		expect(state.dismissedErrorFingerprints.has("error-1")).toBe(true);

		state = reduceWorkspaceExpansion(state, {
			type: "error_observed",
			fingerprint: "error-2",
			replayed: true,
		});
		expect(state.internalSection).toBe("errors");
	});
});
