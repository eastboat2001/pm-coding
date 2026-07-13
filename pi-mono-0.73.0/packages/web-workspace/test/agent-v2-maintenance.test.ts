import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_V2_RESET_CONFIRMATION,
	clearAgentV2GeneratedProjectWorkspaces,
	resetAgentV2Runtime,
} from "../src/agent-v2-maintenance.js";
import type { AgentV2ResetStore } from "../src/agent-v2-runtime-store.js";

const STORE_RESULT = {
	agentV2RowsDeleted: { agent_v2_runs: 2 },
	schemaVersion: 2 as const,
};

describe("agent v2 runtime reset maintenance", () => {
	let tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { force: true, recursive: true });
		}
		tempDirs = [];
	});

	it("refuses destructive reset without the confirmation token", async () => {
		const { store, resetAgentV2RuntimeData } = createStore();

		await expect(resetAgentV2Runtime({ store })).rejects.toThrow("confirmation token");
		expect(resetAgentV2RuntimeData).not.toHaveBeenCalled();
	});

	it("passes only the v2 reset clock to the store reset", async () => {
		const { store, resetAgentV2RuntimeData } = createStore();
		const now = () => "2026-07-07T05:00:00.000Z";

		const result = await resetAgentV2Runtime({
			store,
			confirmation: AGENT_V2_RESET_CONFIRMATION,
			now,
		});

		expect(resetAgentV2RuntimeData).toHaveBeenCalledWith({ now });
		expect(result.store).toEqual(STORE_RESULT);
	});

	it("only calls optional maintenance adapters when their include flags are true", async () => {
		const { store } = createStore();
		const clientsRootDir = createTempDir();
		const projectDir = join(clientsRootDir, "client-a", "sessions", "session-a", "project");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "index.html"), "<h1>Project</h1>");
		const queue = {
			clear: vi.fn(async () => ({ queueItemsDeleted: 4, activeClaimsDeleted: 3, cancelKeysDeleted: 2 })),
		};
		const eventBus = {
			purge: vi.fn(async () => ({ streamsDeleted: 5 })),
		};
		const diagnostics = {
			clearAgentV2Diagnostics: vi.fn(() => 6),
		};

		const withoutOptionalAdapters = await resetAgentV2Runtime({
			store,
			queue,
			eventBus,
			diagnostics,
			clientsRootDir,
			confirmation: AGENT_V2_RESET_CONFIRMATION,
		});

		expect(queue.clear).not.toHaveBeenCalled();
		expect(eventBus.purge).not.toHaveBeenCalled();
		expect(diagnostics.clearAgentV2Diagnostics).not.toHaveBeenCalled();
		expect(existsSync(projectDir)).toBe(true);
		expect(withoutOptionalAdapters.queue).toBeUndefined();
		expect(withoutOptionalAdapters.liveEvents).toBeUndefined();
		expect(withoutOptionalAdapters.diagnosticsDeleted).toBeUndefined();
		expect(withoutOptionalAdapters.generatedProjects).toBeUndefined();

		const withOptionalAdapters = await resetAgentV2Runtime({
			store,
			queue,
			eventBus,
			diagnostics,
			clientsRootDir,
			confirmation: AGENT_V2_RESET_CONFIRMATION,
			includeQueue: true,
			includeLiveEvents: true,
			includeDiagnostics: true,
			includeGeneratedProjects: true,
		});

		expect(queue.clear).toHaveBeenCalledTimes(1);
		expect(eventBus.purge).toHaveBeenCalledTimes(1);
		expect(diagnostics.clearAgentV2Diagnostics).toHaveBeenCalledTimes(1);
		expect(withOptionalAdapters.queue).toEqual({
			queueItemsDeleted: 4,
			activeClaimsDeleted: 3,
			cancelKeysDeleted: 2,
		});
		expect(withOptionalAdapters.liveEvents).toEqual({ streamsDeleted: 5 });
		expect(withOptionalAdapters.diagnosticsDeleted).toBe(6);
		expect(withOptionalAdapters.generatedProjects).toEqual({ projectDirectoriesDeleted: 1 });
		expect(existsSync(projectDir)).toBe(false);
	});

	it("deletes only generated project directories under client sessions", () => {
		const clientsRootDir = createTempDir();
		const clientAProject = join(clientsRootDir, "client-a", "sessions", "session-a", "project");
		const clientANotes = join(clientsRootDir, "client-a", "sessions", "session-a", "notes.txt");
		const clientBProject = join(clientsRootDir, "client-b", "sessions", "session-b", "project");
		const clientBKeep = join(clientsRootDir, "client-b", "keep.txt");
		mkdirSync(clientAProject, { recursive: true });
		mkdirSync(clientBProject, { recursive: true });
		writeFileSync(join(clientAProject, "index.html"), "<h1>Project A</h1>");
		writeFileSync(clientANotes, "keep session notes");
		writeFileSync(join(clientBProject, ".pi-project.json"), "{}");
		writeFileSync(clientBKeep, "keep client file");

		const result = clearAgentV2GeneratedProjectWorkspaces(clientsRootDir);

		expect(result).toEqual({ projectDirectoriesDeleted: 2 });
		expect(existsSync(clientAProject)).toBe(false);
		expect(existsSync(clientBProject)).toBe(false);
		expect(existsSync(clientANotes)).toBe(true);
		expect(existsSync(clientBKeep)).toBe(true);
		expect(existsSync(join(clientsRootDir, "client-a", "sessions", "session-a"))).toBe(true);
		expect(existsSync(join(clientsRootDir, "client-b", "sessions", "session-b"))).toBe(true);
	});

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-agent-v2-maintenance-"));
		tempDirs.push(dir);
		return dir;
	}
});

function createStore(): {
	store: AgentV2ResetStore;
	resetAgentV2RuntimeData: ReturnType<typeof vi.fn>;
} {
	const resetAgentV2RuntimeData = vi.fn(async () => STORE_RESULT);
	return {
		store: { resetAgentV2RuntimeData } as AgentV2ResetStore,
		resetAgentV2RuntimeData,
	};
}
