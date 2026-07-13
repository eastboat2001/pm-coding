import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectBuildManifest } from "../src/build-manifest-policy.js";
import { BuildRunnerError } from "../src/build-runner.js";

describe("inspectBuildManifest", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "pi-build-manifest-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { force: true, recursive: true });
	});

	it("returns fixed argv-only npm commands and the static output allowlist", () => {
		writePackage({ scripts: { build: "vite build" } });

		const plan = inspect();

		expect(plan).toEqual({
			buildCommand: ["npm", "--ignore-scripts", "--userconfig", "/etc/npmrc", "run", "build"],
			outputDirectories: ["dist", "build", "public"],
		});
		expect(typeof plan.buildCommand).not.toBe("string");
	});

	it("requires an object package manifest with a string build script", () => {
		writeFileSync(join(projectRoot, "package.json"), "[]", "utf8");
		expectPolicyRejection(() => inspect());

		writePackage({ scripts: {} });
		expectPolicyRejection(() => inspect());

		writePackage({ scripts: { build: ["vite", "build"] } });
		expectPolicyRejection(() => inspect());
	});

	it("turns missing, unreadable, and malformed manifests into typed policy rejections", () => {
		expectPolicyRejection(() => inspect());

		mkdirSync(join(projectRoot, "package.json"));
		expectPolicyRejection(() => inspect());
		rmSync(join(projectRoot, "package.json"), { recursive: true });

		writeFileSync(join(projectRoot, "package.json"), "{secret-token", "utf8");
		const error = capturePolicyRejection(() => inspect());
		expect(error.message).not.toContain("secret-token");
	});

	it("rejects project npm configuration", () => {
		writePackage({ scripts: { build: "vite build" } });
		writeFileSync(join(projectRoot, ".npmrc"), "//registry.example/:_authToken=secret-token", "utf8");

		const error = capturePolicyRejection(() => inspect());

		expect(error.message).not.toContain("secret-token");
	});

	it.each(["yarn.lock", "pnpm-lock.yaml", "pnpm-lock.yml", "bun.lock", "bun.lockb"])(
		"rejects unsupported package-manager lockfile %s",
		(lockfile) => {
			writePackage({ scripts: { build: "vite build" } });
			writeFileSync(join(projectRoot, lockfile), "lock", "utf8");

			expectPolicyRejection(() => inspect());
		},
	);

	it("rejects npm-shrinkwrap even when package-lock is valid and allowlisted", () => {
		writePackage({ dependencies: { vite: "^7.0.0" }, scripts: { build: "vite build" } });
		writeLock({
			packages: {
				"node_modules/vite": { resolved: "https://registry.example/vite/-/vite-7.0.0.tgz" },
			},
		});
		writeFileSync(
			join(projectRoot, "npm-shrinkwrap.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"": {},
					"node_modules/vite": { resolved: "https://evil.example/vite/-/vite-7.0.0.tgz" },
				},
			}),
			"utf8",
		);

		expectPolicyRejection(() => inspect());
	});

	it("allows only npm packageManager declarations", () => {
		writePackage({ packageManager: "pnpm@10.0.0", scripts: { build: "vite build" } });
		expectPolicyRejection(() => inspect());

		writePackage({ packageManager: "npm@11.4.2", scripts: { build: "vite build" } });
		expect(inspect().buildCommand[0]).toBe("npm");
	});

	it.each(["prebuild", "postbuild", "preinstall", "install", "postinstall", "prepare"])(
		"rejects the %s lifecycle hook",
		(hook) => {
			writePackage({ scripts: { build: "vite build", [hook]: "node unsafe.js" } });

			expectPolicyRejection(() => inspect());
		},
	);

	it.each([
		"file:../shared",
		"link:../shared",
		"workspace:*",
		"git:https://example.com/repo.git",
		"git+https://example.com/repo.git",
		"github:user/repo",
		"http://registry.example/pkg.tgz",
		"user/repo",
		"git@github.com:user/repo.git",
		"git+ssh://git@github.com/user/repo.git",
		"npm:foo@file:../local",
		"npm:foo@git+https://evil.example/x.git",
		"npm:foo@http://evil.example/x.tgz",
	])("rejects unsafe dependency spec %s", (spec) => {
		writePackage({ dependencies: { unsafe: spec }, scripts: { build: "vite build" } });
		writeLock();

		expectPolicyRejection(() => inspect());
	});

	it("requires a valid package-lock when dependencies are declared", () => {
		writePackage({ dependencies: { vite: "^7.0.0" }, scripts: { build: "vite build" } });
		expectPolicyRejection(() => inspect());

		writeFileSync(join(projectRoot, "package-lock.json"), "not-json secret-token", "utf8");
		const error = capturePolicyRejection(() => inspect());
		expect(error.message).not.toContain("secret-token");
	});

	it("uses fixed safe npm restore argv when dependencies are declared", () => {
		writePackage({
			dependencies: { vite: "^7.0.0" },
			devDependencies: { typescript: "npm:typescript@^5.7.0" },
			scripts: { build: "vite build" },
		});
		writeLock({
			packages: {
				"node_modules/vite": { resolved: "https://registry.example/vite/-/vite-7.0.0.tgz" },
			},
		});

		const plan = inspect();

		expect(plan.restoreCommand).toEqual([
			"npm",
			"ci",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--userconfig",
			"/etc/npmrc",
		]);
		expect(typeof plan.restoreCommand).not.toBe("string");
	});

	it("rejects plain HTTP and off-allowlist lockfile resolved URLs", () => {
		writePackage({ dependencies: { vite: "^7.0.0" }, scripts: { build: "vite build" } });

		writeLock({ packages: { "node_modules/vite": { resolved: "http://registry.example/vite.tgz" } } });
		expectPolicyRejection(() => inspect());

		writeLock({ packages: { "node_modules/vite": { resolved: "https://evil.example/vite.tgz" } } });
		expectPolicyRejection(() => inspect());
	});

	it("matches registry hosts and normalized ports exactly", () => {
		writePackage({ dependencies: { vite: "^7.0.0" }, scripts: { build: "vite build" } });

		writeLock({ packages: { "node_modules/vite": { resolved: "https://registry.example.evil/vite.tgz" } } });
		expectPolicyRejection(() => inspect());

		writeLock({ packages: { "node_modules/vite": { resolved: "https://registry.example:444/vite.tgz" } } });
		expectPolicyRejection(() => inspect());

		writeLock({ packages: { "node_modules/vite": { resolved: "https://REGISTRY.EXAMPLE:443/vite.tgz" } } });
		expect(inspect().restoreCommand?.[0]).toBe("npm");
	});

	it("rejects registry allowlist entries that are not pure HTTPS origins", () => {
		writePackage({ dependencies: { vite: "^7.0.0" }, scripts: { build: "vite build" } });
		writeLock({ packages: { "node_modules/vite": { resolved: "https://registry.example/vite.tgz" } } });

		for (const registryOrigin of [
			"http://registry.example",
			"https://registry.example/private",
			"https://user:password@registry.example",
		]) {
			expectPolicyRejection(() => inspect([registryOrigin]));
		}
	});

	it("rejects unknown lockfile versions", () => {
		writePackage({ dependencies: { vite: "^7.0.0" }, scripts: { build: "vite build" } });
		writeRawLock({ lockfileVersion: 999, packages: { "": {} } });

		expectPolicyRejection(() => inspect());
	});

	it.each([
		{ lockfileVersion: 1, packages: { "": {} } },
		{ dependencies: {}, lockfileVersion: 2 },
		{ lockfileVersion: 2, packages: {} },
		{ lockfileVersion: 2, packages: { "": "not-an-object" } },
		{ dependencies: {}, lockfileVersion: 3 },
		{ lockfileVersion: 3, packages: {} },
		{ lockfileVersion: 3, packages: { "": "not-an-object" } },
	])("rejects lockfile schema mismatch %#", (lock) => {
		writePackage({ dependencies: { vite: "^7.0.0" }, scripts: { build: "vite build" } });
		writeRawLock(lock);

		expectPolicyRejection(() => inspect());
	});

	it("accepts the supported v1 lockfile schema", () => {
		writePackage({ dependencies: { vite: "^7.0.0" }, scripts: { build: "vite build" } });
		writeRawLock({
			dependencies: {
				vite: { resolved: "https://registry.example/vite/-/vite-7.0.0.tgz" },
			},
			lockfileVersion: 1,
		});

		expect(inspect().restoreCommand?.[0]).toBe("npm");
	});

	it("accepts the supported v2 lockfile schema", () => {
		writePackage({ dependencies: { vite: "^7.0.0" }, scripts: { build: "vite build" } });
		writeRawLock({
			lockfileVersion: 2,
			packages: {
				"": {},
				"node_modules/vite": { resolved: "https://registry.example/vite/-/vite-7.0.0.tgz" },
			},
		});

		expect(inspect().restoreCommand?.[0]).toBe("npm");
	});

	function inspect(
		registryOrigins: readonly string[] = ["https://registry.example"],
	): ReturnType<typeof inspectBuildManifest> {
		return inspectBuildManifest({ projectRoot, registryOrigins });
	}

	function writePackage(manifest: Record<string, unknown>): void {
		writeFileSync(join(projectRoot, "package.json"), JSON.stringify(manifest), "utf8");
	}

	function writeLock(overrides: Record<string, unknown> = {}): void {
		const packages = isRecord(overrides.packages) ? { "": {}, ...overrides.packages } : { "": {} };
		writeRawLock({ lockfileVersion: 3, ...overrides, packages });
	}

	function writeRawLock(lock: Record<string, unknown>): void {
		writeFileSync(join(projectRoot, "package-lock.json"), JSON.stringify(lock), "utf8");
	}
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectPolicyRejection(action: () => unknown): void {
	capturePolicyRejection(action);
}

function capturePolicyRejection(action: () => unknown): BuildRunnerError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(BuildRunnerError);
		expect(error).toMatchObject({ code: "build.policy_rejected" });
		return error as BuildRunnerError;
	}
	throw new Error("Expected build manifest policy rejection");
}
