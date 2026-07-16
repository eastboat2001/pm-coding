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

export function reduceWorkspaceExpansion(
	state: WorkspaceExpansionState,
	action: WorkspaceExpansionAction,
): WorkspaceExpansionState {
	switch (action.type) {
		case "set_viewport": {
			const hasRunDetail = state.activeRunDetailOpen || state.historicalRunDetailId !== null;
			return {
				...state,
				viewport: action.viewport,
				sidebar: action.viewport === "compact" && state.sidebar && hasRunDetail ? null : state.sidebar,
			};
		}
		case "open_sidebar":
			return {
				...state,
				sidebar: action.sidebar,
				...(state.viewport === "compact"
					? { activeRunDetailOpen: false, historicalRunDetailId: null }
					: {}),
			};
		case "close_sidebar":
			return { ...state, sidebar: null };
		case "open_file_preview":
			return { ...state, filePreviewPath: action.path };
		case "close_file_preview":
			return { ...state, filePreviewPath: null };
		case "open_active_run_detail":
			return { ...state, activeRunDetailOpen: true, ...(state.viewport === "compact" ? { sidebar: null } : {}) };
		case "close_active_run_detail":
			return { ...state, activeRunDetailOpen: false };
		case "open_historical_run_detail":
			return {
				...state,
				historicalRunDetailId: action.runId,
				...(state.viewport === "compact" ? { sidebar: null } : {}),
			};
		case "close_historical_run_detail":
			return { ...state, historicalRunDetailId: null };
		case "open_internal_section":
			return { ...state, internalSection: action.section };
		case "close_internal_section":
			return { ...state, internalSection: null };
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
