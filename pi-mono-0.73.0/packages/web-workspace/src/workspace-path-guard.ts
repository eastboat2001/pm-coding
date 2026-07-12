import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";

export type WorkspacePathPolicy = "project_content" | "trusted_lifecycle";
export type WorkspacePathExpectedType = "any" | "file" | "directory";
export type WorkspacePathAuthorizationCode =
	| "path_empty"
	| "path_absolute"
	| "path_component_invalid"
	| "path_device_reserved"
	| "path_internal"
	| "path_missing"
	| "path_type_invalid"
	| "path_symlink"
	| "path_escape";

export class WorkspacePathAuthorizationError extends Error {
	constructor(
		readonly code: WorkspacePathAuthorizationCode,
		message: string,
	) {
		super(message);
		this.name = "WorkspacePathAuthorizationError";
	}
}

export interface AuthorizedWorkspacePath {
	relativePath: string;
	absolutePath: string;
	realRoot: string;
}

const WINDOWS_DEVICE_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const INVALID_COMPONENT_CHARACTERS = /[<>:"|?*\u0000-\u001f]/;
const INTERNAL_PROJECT_FILES = new Set([".pi-project.json", ".pi-project-files.json"]);

export class WorkspacePathGuard {
	private readonly realRoot: string;

	private constructor(
		root: string,
		private readonly policy: WorkspacePathPolicy,
	) {
		try {
			this.realRoot = realpathSync.native(resolve(root));
		} catch (error) {
			throw missingPathError(root, error);
		}
		if (!lstatSync(this.realRoot).isDirectory()) {
			throw new WorkspacePathAuthorizationError("path_type_invalid", "Workspace root is not a directory.");
		}
	}

	static forProjectContent(root: string): WorkspacePathGuard {
		return new WorkspacePathGuard(root, "project_content");
	}

	static forTrustedLifecycle(root: string): WorkspacePathGuard {
		return new WorkspacePathGuard(root, "trusted_lifecycle");
	}

	normalizeRelativePath(input: string): string {
		if (input.length === 0 || input.trim().length === 0) {
			throw new WorkspacePathAuthorizationError("path_empty", "Workspace path is empty.");
		}
		if (isCrossPlatformAbsolute(input)) {
			throw new WorkspacePathAuthorizationError("path_absolute", "Workspace path must be relative.");
		}

		const components = input.split(/[\\/]/);
		for (const component of components) this.validateComponent(component);
		return join(...components);
	}

	authorizeExisting(input: string, expectedType: WorkspacePathExpectedType = "any"): AuthorizedWorkspacePath {
		const relativePath = this.normalizeRelativePath(input);
		const absolutePath = join(this.realRoot, relativePath);
		const stat = this.inspectExistingSegments(relativePath);
		assertExpectedType(stat, expectedType, relativePath);
		return { relativePath, absolutePath, realRoot: this.realRoot };
	}

	authorizeNew(input: string): AuthorizedWorkspacePath {
		const relativePath = this.normalizeRelativePath(input);
		const absolutePath = join(this.realRoot, relativePath);
		let candidate = this.realRoot;
		for (const component of relativePath.split(sep)) {
			candidate = join(candidate, component);
			try {
				const stat = lstatSync(candidate);
				if (stat.isSymbolicLink()) this.throwSymlink(relativePath);
			} catch (error) {
				if (isMissingError(error)) break;
				throw error;
			}
		}

		const existingParent = findExistingParent(absolutePath);
		this.assertContained(realpathSync.native(existingParent));
		return { relativePath, absolutePath, realRoot: this.realRoot };
	}

	authorizeAbsoluteExisting(target: string, expectedType: WorkspacePathExpectedType = "any"): AuthorizedWorkspacePath {
		if (!isAbsolute(target)) {
			throw new WorkspacePathAuthorizationError("path_absolute", "Workspace target must be absolute.");
		}
		const absolutePath = resolve(target);
		const relativePath = relative(this.realRoot, absolutePath);
		this.assertContained(absolutePath);
		if (!relativePath) {
			const stat = lstatSync(this.realRoot);
			assertExpectedType(stat, expectedType, this.realRoot);
			return { relativePath: ".", absolutePath: this.realRoot, realRoot: this.realRoot };
		}
		return this.authorizeExisting(relativePath, expectedType);
	}

	private validateComponent(component: string): void {
		if (component === "" || component === "." || component === "..") {
			throw new WorkspacePathAuthorizationError("path_component_invalid", "Workspace path component is invalid.");
		}

		const deviceCandidate =
			component
				.replace(/[ .]+$/g, "")
				.split(".")[0]
				?.replace(/[ .]+$/g, "") ?? "";
		if (WINDOWS_DEVICE_NAMES.test(deviceCandidate)) {
			throw new WorkspacePathAuthorizationError(
				"path_device_reserved",
				`Workspace path component is a reserved device name: ${component}`,
			);
		}
		if (component.trim() !== component || component.endsWith(".") || INVALID_COMPONENT_CHARACTERS.test(component)) {
			throw new WorkspacePathAuthorizationError(
				"path_component_invalid",
				`Workspace path component is invalid: ${component}`,
			);
		}

		if (this.policy === "project_content") {
			const lowerComponent = component.toLowerCase();
			if (lowerComponent === ".pi" || INTERNAL_PROJECT_FILES.has(lowerComponent)) {
				throw new WorkspacePathAuthorizationError(
					"path_internal",
					`Workspace path targets internal project state: ${component}`,
				);
			}
		}
	}

	private inspectExistingSegments(relativePath: string): Stats {
		let candidate = this.realRoot;
		let finalStat: Stats | undefined;
		for (const component of relativePath.split(sep)) {
			candidate = join(candidate, component);
			try {
				finalStat = lstatSync(candidate);
			} catch (error) {
				throw missingPathError(relativePath, error);
			}
			if (finalStat.isSymbolicLink()) this.throwSymlink(relativePath);
		}
		if (!finalStat) {
			throw new WorkspacePathAuthorizationError("path_missing", `Workspace path does not exist: ${relativePath}`);
		}
		this.assertContained(realpathSync.native(candidate));
		return finalStat;
	}

	private assertContained(target: string): void {
		const relativePath = relative(this.realRoot, target);
		if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			throw new WorkspacePathAuthorizationError("path_escape", "Workspace path escapes the configured root.");
		}
	}

	private throwSymlink(relativePath: string): never {
		throw new WorkspacePathAuthorizationError(
			"path_symlink",
			`Workspace path traverses a symbolic link: ${relativePath}`,
		);
	}
}

function isCrossPlatformAbsolute(path: string): boolean {
	return posix.isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path);
}

function assertExpectedType(stat: Stats, expectedType: WorkspacePathExpectedType, path: string): void {
	if ((expectedType === "file" && !stat.isFile()) || (expectedType === "directory" && !stat.isDirectory())) {
		throw new WorkspacePathAuthorizationError("path_type_invalid", `Workspace path has the wrong type: ${path}`);
	}
}

function findExistingParent(path: string): string {
	let candidate = path;
	while (true) {
		try {
			lstatSync(candidate);
			return candidate;
		} catch (error) {
			if (!isMissingError(error)) throw error;
			const parent = resolve(candidate, "..");
			if (parent === candidate) throw missingPathError(path, error);
			candidate = parent;
		}
	}
}

function missingPathError(path: string, error: unknown): WorkspacePathAuthorizationError {
	if (isMissingError(error)) {
		return new WorkspacePathAuthorizationError("path_missing", `Workspace path does not exist: ${path}`);
	}
	throw error;
}

function isMissingError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
