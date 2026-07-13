import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BuildOutputDirectory, BuildRunnerError } from "./build-runner.js";

const TRUSTED_NPMRC_PATH = "/etc/npmrc";
const UNSUPPORTED_LOCKFILES = [
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"pnpm-lock.yml",
	"bun.lock",
	"bun.lockb",
] as const;
const FORBIDDEN_LIFECYCLE_SCRIPTS = [
	"prebuild",
	"postbuild",
	"preinstall",
	"install",
	"postinstall",
	"prepare",
] as const;
const OUTPUT_DIRECTORIES: readonly BuildOutputDirectory[] = ["dist", "build", "public"];

export interface BuildManifestPlan {
	restoreCommand?: readonly string[];
	buildCommand: readonly string[];
	outputDirectories: readonly BuildOutputDirectory[];
}

export function inspectBuildManifest(input: {
	projectRoot: string;
	registryOrigins: readonly string[];
}): BuildManifestPlan {
	try {
		return inspectBuildManifestUnsafe(input);
	} catch (error) {
		if (error instanceof BuildRunnerError) throw error;
		throw policyRejection("Build manifest could not be inspected.");
	}
}

function inspectBuildManifestUnsafe(input: {
	projectRoot: string;
	registryOrigins: readonly string[];
}): BuildManifestPlan {
	const allowedRegistryHosts = normalizeRegistryOrigins(input.registryOrigins);
	const packagePath = join(input.projectRoot, "package.json");
	const manifest = readJsonObject(packagePath, "Package manifest is missing or invalid.");

	if (existsSync(join(input.projectRoot, ".npmrc"))) {
		throw policyRejection("Project npm configuration is not allowed.");
	}
	for (const lockfile of UNSUPPORTED_LOCKFILES) {
		if (existsSync(join(input.projectRoot, lockfile))) {
			throw policyRejection("Unsupported package-manager lockfile.");
		}
	}

	validatePackageManager(manifest.packageManager);
	const scripts = objectProperty(manifest, "scripts", "Package scripts must be an object.");
	if (typeof scripts.build !== "string" || scripts.build.trim().length === 0) {
		throw policyRejection("Package manifest requires a string build script.");
	}
	for (const scriptName of FORBIDDEN_LIFECYCLE_SCRIPTS) {
		if (Object.hasOwn(scripts, scriptName)) {
			throw policyRejection("Package manifest contains a forbidden lifecycle script.");
		}
	}

	const dependencyCount =
		validateDependencies(manifest, "dependencies", allowedRegistryHosts) +
		validateDependencies(manifest, "devDependencies", allowedRegistryHosts);
	const packageLockPath = join(input.projectRoot, "package-lock.json");
	const hasPackageLock = existsSync(packageLockPath);
	if (dependencyCount > 0 && !hasPackageLock) {
		throw policyRejection("Dependencies require package-lock.json.");
	}
	if (hasPackageLock) {
		validatePackageLock(readJsonObject(packageLockPath, "Package lock is invalid."), allowedRegistryHosts);
	}

	return {
		...(dependencyCount > 0
			? {
					restoreCommand: [
						"npm",
						"ci",
						"--ignore-scripts",
						"--no-audit",
						"--no-fund",
						"--userconfig",
						TRUSTED_NPMRC_PATH,
					],
				}
			: {}),
		buildCommand: ["npm", "--ignore-scripts", "--userconfig", TRUSTED_NPMRC_PATH, "run", "build"],
		outputDirectories: OUTPUT_DIRECTORIES,
	};
}

function validatePackageManager(value: unknown): void {
	if (value === undefined) return;
	if (typeof value !== "string" || !/^npm@\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
		throw policyRejection("Only npm packageManager declarations are allowed.");
	}
}

function validateDependencies(
	manifest: Record<string, unknown>,
	property: "dependencies" | "devDependencies",
	allowedRegistryHosts: ReadonlySet<string>,
): number {
	const value = manifest[property];
	if (value === undefined) return 0;
	if (!isObject(value)) throw policyRejection("Dependency declarations must be objects.");
	for (const spec of Object.values(value)) {
		if (typeof spec !== "string" || !isSupportedDependencySpec(spec, allowedRegistryHosts)) {
			throw policyRejection("Package manifest contains an unsupported dependency specification.");
		}
	}
	return Object.keys(value).length;
}

function isSupportedDependencySpec(spec: string, allowedRegistryHosts: ReadonlySet<string>): boolean {
	const trimmed = spec.trim();
	if (trimmed.startsWith("npm:")) {
		return isSupportedNpmAlias(trimmed);
	}
	if (trimmed.startsWith("https:")) {
		return urlUsesAllowedRegistry(trimmed, allowedRegistryHosts);
	}
	return isRegistrySelector(trimmed);
}

function isSupportedNpmAlias(spec: string): boolean {
	const match = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(.+)$/.exec(spec);
	return match !== null && isRegistrySelector(match[2] ?? "");
}

function isRegistrySelector(selector: string): boolean {
	return selector.length > 0 && /^[0-9A-Za-z*^~<>=|._+ -]+$/.test(selector);
}

function validatePackageLock(lock: Record<string, unknown>, allowedRegistryHosts: ReadonlySet<string>): void {
	const lockfileVersion = lock.lockfileVersion;
	if (lockfileVersion !== 1 && lockfileVersion !== 2 && lockfileVersion !== 3) {
		throw policyRejection("Package lock is invalid.");
	}
	if (lockfileVersion === 1 && !isObject(lock.dependencies)) {
		throw policyRejection("Package lock is invalid.");
	}
	if (lockfileVersion === 2 || lockfileVersion === 3) {
		if (!isObject(lock.packages) || !isObject(lock.packages[""])) {
			throw policyRejection("Package lock is invalid.");
		}
	}
	visitLockValues(lock, allowedRegistryHosts, new Set<object>());
}

function visitLockValues(value: unknown, allowedRegistryHosts: ReadonlySet<string>, seen: Set<object>): void {
	if (!isObject(value) || seen.has(value)) return;
	seen.add(value);
	for (const [key, child] of Object.entries(value)) {
		if (key === "resolved") {
			if (typeof child !== "string" || !urlUsesAllowedRegistry(child, allowedRegistryHosts)) {
				throw policyRejection("Package lock contains a disallowed resolved URL.");
			}
			continue;
		}
		if (Array.isArray(child)) {
			for (const item of child) visitLockValues(item, allowedRegistryHosts, seen);
		} else {
			visitLockValues(child, allowedRegistryHosts, seen);
		}
	}
}

function normalizeRegistryOrigins(origins: readonly string[]): ReadonlySet<string> {
	const normalized = new Set<string>();
	for (const origin of origins) {
		let url: URL;
		try {
			url = new URL(origin);
		} catch {
			throw policyRejection("Registry allowlist contains an invalid origin.");
		}
		if (
			url.protocol !== "https:" ||
			!url.hostname ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		) {
			throw policyRejection("Registry allowlist requires pure HTTPS origins.");
		}
		normalized.add(url.host);
	}
	return normalized;
}

function urlUsesAllowedRegistry(value: string, allowedRegistryHosts: ReadonlySet<string>): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			Boolean(url.hostname) &&
			allowedRegistryHosts.has(url.host)
		);
	} catch {
		return false;
	}
}

function readJsonObject(path: string, rejectionMessage: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isObject(value)) return value;
	} catch {
		throw policyRejection(rejectionMessage);
	}
	throw policyRejection(rejectionMessage);
}

function objectProperty(
	value: Record<string, unknown>,
	property: string,
	rejectionMessage: string,
): Record<string, unknown> {
	const propertyValue = value[property];
	if (!isObject(propertyValue)) throw policyRejection(rejectionMessage);
	return propertyValue;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyRejection(message: string): BuildRunnerError {
	return new BuildRunnerError("build.policy_rejected", message);
}
