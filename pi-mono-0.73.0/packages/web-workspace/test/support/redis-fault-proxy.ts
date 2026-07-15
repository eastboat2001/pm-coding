import { createServer, type Server, Socket } from "node:net";

export interface RedisFaultProxy {
	readonly url: string;
	dropNextEvalResponse(): void;
	close(): Promise<void>;
}

export async function createRedisFaultProxy(targetUrl: string): Promise<RedisFaultProxy> {
	const target = new URL(targetUrl);
	let dropNext = false;
	const sockets = new Set<Socket>();
	const server: Server = createServer((downstream) => {
		const upstream = new Socket();
		let evalSeen = false;
		sockets.add(downstream);
		sockets.add(upstream);
		downstream.on("data", (chunk: Buffer) => {
			if (chunk.includes(Buffer.from("EVAL", "ascii"))) evalSeen = true;
			upstream.write(chunk);
		});
		upstream.on("data", (chunk) => {
			if (dropNext && evalSeen) {
				dropNext = false;
				downstream.destroy();
				upstream.destroy();
				return;
			}
			downstream.write(chunk);
		});
		const cleanup = () => {
			sockets.delete(downstream);
			sockets.delete(upstream);
		};
		downstream.once("close", cleanup);
		upstream.once("close", cleanup);
		downstream.once("error", () => upstream.destroy());
		upstream.once("error", () => downstream.destroy());
		downstream.once("end", () => upstream.end());
		upstream.once("end", () => downstream.end());
		upstream.connect(Number(target.port || 6379), target.hostname);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Redis fault proxy did not bind a TCP port");
	return {
		url: `redis://127.0.0.1:${address.port}`,
		dropNextEvalResponse: () => {
			dropNext = true;
		},
		close: async () => {
			for (const socket of [...sockets]) socket.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}
