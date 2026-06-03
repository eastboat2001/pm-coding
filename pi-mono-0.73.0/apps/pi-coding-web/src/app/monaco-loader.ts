type MonacoRuntime = typeof import("./monaco-runtime.js");

let monacoPromise: Promise<MonacoRuntime["monaco"]> | undefined;

export async function loadMonaco(): Promise<MonacoRuntime["monaco"]> {
	if (!monacoPromise) {
		monacoPromise = import("./monaco-runtime.js").then((module) => module.monaco);
	}
	return monacoPromise;
}
