import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type WorkspacePathAuthorizationCode,
	WorkspacePathAuthorizationError,
	WorkspacePathGuard,
} from "../src/workspace-path-guard.js";

describe("WorkspacePathGuard", () => {
	let sandbox: string;
	let root: string;
	let outside: string;

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "pi-workspace-path-guard-"));
		root = join(sandbox, "project");
		outside = join(sandbox, "project-copy");
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(root, "README.md"), "inside", "utf8");
		writeFileSync(join(outside, "outside.txt"), "outside", "utf8");
	});

	afterEach(() => {
		rmSync(sandbox, { force: true, recursive: true });
	});

	it("rejects empty, absolute, and invalid relative paths before normalization", () => {
		const guard = WorkspacePathGuard.forProjectContent(root);

		for (const input of ["", "   "]) expectAuthorizationCode(() => guard.normalizeRelativePath(input), "path_empty");
		for (const input of [
			"/tmp/outside",
			String.raw`C:\outside\file.txt`,
			String.raw`C:outside\file.txt`,
			String.raw`\\server\share\file.txt`,
			String.raw`\\?\C:\outside\file.txt`,
			String.raw`\\.\PhysicalDrive0`,
		]) {
			expectAuthorizationCode(() => guard.normalizeRelativePath(input), "path_absolute");
		}
		for (const input of [
			".",
			"..",
			"src/./file.txt",
			"src/../file.txt",
			"src//file.txt",
			String.raw`src\\file.txt`,
			"src/",
			"bad:name.txt",
		]) {
			expectAuthorizationCode(() => guard.normalizeRelativePath(input), "path_component_invalid");
		}

		expect(guard.normalizeRelativePath(String.raw`src\nested/file.txt`)).toBe(join("src", "nested", "file.txt"));
	});

	it("rejects Windows device names even with extensions, trailing dots, spaces, or case changes", () => {
		const guard = WorkspacePathGuard.forProjectContent(root);

		for (const input of ["CON", "con.txt", "NUL.", "COM1   ", "src/LpT9.md"]) {
			expectAuthorizationCode(() => guard.normalizeRelativePath(input), "path_device_reserved");
		}
	});

	it("keeps project content out of internal workspace paths case-insensitively", () => {
		const guard = WorkspacePathGuard.forProjectContent(root);

		for (const input of [
			".pi/state.json",
			".PI/build-staging/output.txt",
			".PI-PROJECT.JSON",
			"src/.Pi-PrOjEcT-FiLeS.JsOn",
		]) {
			expectAuthorizationCode(() => guard.normalizeRelativePath(input), "path_internal");
		}
	});

	it("authorizes existing files and directories and fails closed for missing or wrong types", () => {
		const guard = WorkspacePathGuard.forProjectContent(root);

		expect(guard.authorizeExisting("README.md", "file")).toEqual({
			relativePath: "README.md",
			absolutePath: join(root, "README.md"),
			realRoot: realpathSync.native(root),
		});
		expect(guard.authorizeExisting("src", "directory").relativePath).toBe("src");
		expectAuthorizationCode(() => guard.authorizeExisting("missing.txt"), "path_missing");
		expectAuthorizationCode(() => guard.authorizeExisting("README.md", "directory"), "path_type_invalid");
		expectAuthorizationCode(() => guard.authorizeExisting("src", "file"), "path_type_invalid");
	});

	it("uses native relative containment for absolute existing paths instead of string prefixes", () => {
		const guard = WorkspacePathGuard.forProjectContent(root);

		expect(guard.authorizeAbsoluteExisting(join(root, "README.md"), "file").relativePath).toBe("README.md");
		expectAuthorizationCode(
			() => guard.authorizeAbsoluteExisting(join(outside, "outside.txt"), "file"),
			"path_escape",
		);
	});

	it("rejects a real external directory link for existing and new paths", () => {
		const linkedDirectory = join(root, "linked");
		symlinkSync(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
		const guard = WorkspacePathGuard.forProjectContent(root);

		expectAuthorizationCode(() => guard.authorizeExisting("linked/outside.txt", "file"), "path_symlink");
		expectAuthorizationCode(() => guard.authorizeNew("linked/new.txt"), "path_symlink");
	});

	it("authorizes new project paths only through real parents inside the root", () => {
		const guard = WorkspacePathGuard.forProjectContent(root);

		expect(guard.authorizeNew("src/generated/new.txt")).toEqual({
			relativePath: join("src", "generated", "new.txt"),
			absolutePath: join(root, "src", "generated", "new.txt"),
			realRoot: realpathSync.native(root),
		});
	});

	it("allows trusted lifecycle staging paths without weakening link or containment checks", () => {
		mkdirSync(join(root, ".pi", "build-staging"), { recursive: true });
		const trusted = WorkspacePathGuard.forTrustedLifecycle(root);

		expect(trusted.authorizeNew(".pi/build-staging/output.txt").relativePath).toBe(
			join(".pi", "build-staging", "output.txt"),
		);

		const linkedDirectory = join(root, ".pi", "build-staging", "linked");
		symlinkSync(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
		expectAuthorizationCode(() => trusted.authorizeNew(".pi/build-staging/linked/new.txt"), "path_symlink");
		expectAuthorizationCode(
			() => trusted.authorizeAbsoluteExisting(join(outside, "outside.txt"), "file"),
			"path_escape",
		);
	});
});

function expectAuthorizationCode(operation: () => unknown, code: WorkspacePathAuthorizationCode): void {
	try {
		operation();
	} catch (error) {
		expect(error).toBeInstanceOf(WorkspacePathAuthorizationError);
		expect((error as WorkspacePathAuthorizationError).code).toBe(code);
		return;
	}
	throw new Error(`Expected WorkspacePathAuthorizationError with code ${code}.`);
}
