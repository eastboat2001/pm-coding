import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { connect, createServer } from "node:net";

const DEFAULT_PORT_START = 3000;
const DEFAULT_PORT_END = 3999;
const STARTUP_TIMEOUT_MS = 15000;
const HEALTH_POLL_INTERVAL_MS = 250;

export interface NodeServiceRuntimeResult {
	port: number;
	command: string;
	logs: string[];
}

interface ManagedNodeService {
	child: ChildProcess;
	logs: string[];
}

export class NodeServiceRuntime {
	private readonly services = new Map<string, ManagedNodeService>();

	async start(projectId: string, projectDir: string, command: string): Promise<NodeServiceRuntimeResult> {
		this.stop(projectId);

		const port = await findAvailablePort(DEFAULT_PORT_START, DEFAULT_PORT_END);
		const logs: string[] = [`Starting internal Node service on port ${port}\n`, `$ ${command}\n`];
		const child = spawn(command, {
			cwd: projectDir,
			shell: true,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				CI: "true",
				HOST: "0.0.0.0",
				PORT: String(port),
			},
			windowsHide: true,
		});

		const managed = { child, logs };
		this.services.set(projectId, managed);
		child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
		child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
		child.on("exit", () => {
			if (this.services.get(projectId)?.child === child) this.services.delete(projectId);
		});

		try {
			await waitForHttpService(`http://127.0.0.1:${port}/`, child, logs);
		} catch (error) {
			this.stop(projectId);
			throw error;
		}

		return {
			port,
			command,
			logs,
		};
	}

	stop(projectId: string): void {
		const managed = this.services.get(projectId);
		if (!managed) return;
		this.services.delete(projectId);
		killProcessTree(managed.child);
	}

	dispose(): void {
		for (const projectId of this.services.keys()) {
			this.stop(projectId);
		}
	}
}

async function findAvailablePort(start: number, end: number): Promise<number> {
	for (let port = start; port <= end; port += 1) {
		if (await isPortAvailable(port)) return port;
	}
	throw new Error(`No available Node service port found in range ${start}-${end}.`);
}

function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolvePort) => {
		const probe = connect({ host: "127.0.0.1", port });
		const finishProbe = (available: boolean) => {
			probe.destroy();
			resolvePort(available);
		};
		probe.setTimeout(500);
		probe.once("connect", () => finishProbe(false));
		probe.once("timeout", () => finishProbe(false));
		probe.once("error", () => {
			void canBindPort(port).then(resolvePort);
		});
	});
}

function canBindPort(port: number): Promise<boolean> {
	return new Promise((resolvePort) => {
		const server = createServer();
		server.unref();
		server.on("error", () => resolvePort(false));
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolvePort(true));
		});
	});
}

function waitForHttpService(url: string, child: ChildProcess, logs: string[]): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolveReady, rejectReady) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			rejectReady(error);
		};

		const check = async () => {
			if (settled) return;
			if (child.exitCode !== null) {
				fail(new Error(`Node service exited before it became ready.\n${logs.join("").trim()}`));
				return;
			}
			if (Date.now() - startedAt > STARTUP_TIMEOUT_MS) {
				fail(
					new Error(
						`Node service did not respond at ${url} within ${STARTUP_TIMEOUT_MS}ms.\n${logs.join("").trim()}`,
					),
				);
				return;
			}

			try {
				const response = await fetch(url);
				if (response.status < 500) {
					settled = true;
					if (timer) clearTimeout(timer);
					resolveReady();
					return;
				}
			} catch {
				// The service may still be starting.
			}
			timer = setTimeout(check, HEALTH_POLL_INTERVAL_MS);
		};

		child.once("error", (error) => fail(error));
		child.once("exit", (code) =>
			fail(new Error(`Node service exited before startup completed with code ${code}.\n${logs.join("").trim()}`)),
		);
		void check();
	});
}

function killProcessTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
}
