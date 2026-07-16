export type WorkspaceViewport = "desktop" | "compact";
export type WorkspaceSidebar = "files" | "apps";

export interface WorkspaceExpansionState {
	viewport: WorkspaceViewport;
	sidebar: WorkspaceSidebar | null;
	filePreviewPath: string | null;
	activeRunDetailOpen: boolean;
	historicalRunDetailId: string | null;
	internalSection: string | null;
	settingsModalOpen: boolean;
	dismissedErrorFingerprints: ReadonlySet<string>;
}

export type WorkspaceExpansionAction =
	| { type: "set_viewport"; viewport: WorkspaceViewport }
	| { type: "open_sidebar"; sidebar: WorkspaceSidebar }
	| { type: "close_sidebar" }
	| { type: "open_file_preview"; path: string }
	| { type: "close_file_preview" }
	| { type: "open_active_run_detail" }
	| { type: "close_active_run_detail" }
	| { type: "open_historical_run_detail"; runId: string }
	| { type: "close_historical_run_detail" }
	| { type: "open_internal_section"; section: string }
	| { type: "close_internal_section" }
	| { type: "set_active_run_section"; section: string | null }
	| { type: "set_historical_run_section"; runId: string; section: string | null }
	| { type: "reset_active_run_expansion" }
	| { type: "open_settings" }
	| { type: "close_settings" }
	| { type: "dismiss_error"; fingerprint: string }
	| { type: "error_observed"; fingerprint: string; replayed: boolean };

export function createWorkspaceExpansionState(viewport: WorkspaceViewport): WorkspaceExpansionState {
	return {
		viewport,
		sidebar: null,
		filePreviewPath: null,
		activeRunDetailOpen: false,
		historicalRunDetailId: null,
		internalSection: null,
		settingsModalOpen: false,
		dismissedErrorFingerprints: new Set(),
	};
}

export function workspaceViewportForWidth(width: number): WorkspaceViewport {
	return width <= 900 ? "compact" : "desktop";
}

export function reduceWorkspaceExpansion(
	state: WorkspaceExpansionState,
	action: WorkspaceExpansionAction,
): WorkspaceExpansionState {
	switch (action.type) {
		case "set_viewport": {
			if (action.viewport === "compact") {
				if (state.historicalRunDetailId !== null) {
					return {
						...state,
						viewport: action.viewport,
						sidebar: null,
						filePreviewPath: null,
						activeRunDetailOpen: false,
					};
				}
				if (state.activeRunDetailOpen) {
					return { ...state, viewport: action.viewport, sidebar: null, filePreviewPath: null };
				}
				if (state.filePreviewPath !== null) {
					return { ...state, viewport: action.viewport, sidebar: null };
				}
			}
			return {
				...state,
				viewport: action.viewport,
			};
		}
		case "open_sidebar":
			return {
				...state,
				sidebar: action.sidebar,
				...(state.viewport === "compact"
					? { filePreviewPath: null, activeRunDetailOpen: false, historicalRunDetailId: null }
					: {}),
			};
		case "close_sidebar":
			return { ...state, sidebar: null };
		case "open_file_preview":
			return {
				...state,
				filePreviewPath: action.path,
				...(state.viewport === "compact"
					? { sidebar: null, activeRunDetailOpen: false, historicalRunDetailId: null }
					: {}),
			};
		case "close_file_preview":
			return { ...state, filePreviewPath: null };
		case "open_active_run_detail":
			return {
				...state,
				activeRunDetailOpen: true,
				historicalRunDetailId: null,
				internalSection: null,
				...(state.viewport === "compact" ? { sidebar: null, filePreviewPath: null } : {}),
			};
		case "close_active_run_detail":
			return { ...state, activeRunDetailOpen: false };
		case "open_historical_run_detail":
			return {
				...state,
				historicalRunDetailId: action.runId,
				activeRunDetailOpen: false,
				internalSection: null,
				...(state.viewport === "compact" ? { sidebar: null, filePreviewPath: null } : {}),
			};
		case "close_historical_run_detail":
			return { ...state, historicalRunDetailId: null };
		case "open_internal_section":
			return { ...state, internalSection: action.section };
		case "close_internal_section":
			return { ...state, internalSection: null };
		case "set_active_run_section":
			if (!state.activeRunDetailOpen) return state;
			return { ...state, internalSection: action.section };
		case "set_historical_run_section":
			if (state.historicalRunDetailId !== action.runId) return state;
			return { ...state, internalSection: action.section };
		case "reset_active_run_expansion":
			return {
				...state,
				activeRunDetailOpen: false,
				...(state.historicalRunDetailId === null ? { internalSection: null } : {}),
			};
		case "open_settings":
			return { ...state, settingsModalOpen: true };
		case "close_settings":
			return { ...state, settingsModalOpen: false };
		case "dismiss_error": {
			const dismissedErrorFingerprints = new Set(state.dismissedErrorFingerprints);
			dismissedErrorFingerprints.add(action.fingerprint);
			return { ...state, dismissedErrorFingerprints };
		}
		case "error_observed":
			if (action.replayed && state.dismissedErrorFingerprints.has(action.fingerprint)) return state;
			return { ...state, internalSection: "errors" };
	}
}
