import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStorageConfig } from "../src/config.js";
import { WorkspaceDiagnosticLogService } from "../src/diagnostic-log-service.js";

type DiagnosticLogServiceHarness = {
	open(): DatabaseSync;
};

describe("WorkspaceDiagnosticLogService", () => {
	let diagnostics: WorkspaceDiagnosticLogService;
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-diagnostic-log-service-"));
		diagnostics = new WorkspaceDiagnosticLogService({ ...loadStorageConfig(dir), logStdoutEnabled: false });
	});

	afterEach(() => {
		diagnostics.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("opens the diagnostic SQLite database with WAL and a busy timeout", () => {
		const database = (diagnostics as unknown as DiagnosticLogServiceHarness).open();
		const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
		const timeout = database.prepare("PRAGMA busy_timeout").get() as { timeout: number };

		expect(journal.journal_mode.toLowerCase()).toBe("wal");
		expect(timeout.timeout).toBeGreaterThanOrEqual(5000);
	});
});
