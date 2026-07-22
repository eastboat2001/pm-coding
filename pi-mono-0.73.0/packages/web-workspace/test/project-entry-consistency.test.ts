import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessProjectEntryConsistency } from "../src/project-entry-consistency.js";
import { staticServeRootCandidates } from "../src/static-preview.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project entry consistency", () => {
	it("rejects a standalone inline app beside an unreferenced React implementation", () => {
		const root = project();
		write(
			root,
			"package.json",
			JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.2.0" } }),
		);
		write(root, "src/main.tsx", "import App from './App';\nvoid App;");
		write(root, "src/App.tsx", "export default function App() { return <main>React app</main>; }");
		write(
			root,
			"index.html",
			`<!doctype html><style>${".card{display:grid;color:#123}".repeat(30)}</style><body><main>${'<section class="card">inline app</section>'.repeat(20)}</main><script>${"document.body.dataset.ready='true';".repeat(30)}</script></body>`,
		);

		const result = assessProjectEntryConsistency(root);

		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("Build project entry conflict");
		expect(result.errors[0]).toContain("src/main.tsx");
		expect(result.sourceEntries).toEqual(expect.arrayContaining(["src/App.tsx", "src/main.tsx"]));
	});

	it("rejects an orphaned React implementation even when package.json was also omitted", () => {
		const root = project();
		write(root, "src/main.tsx", "document.body.dataset.ready = 'true';");
		write(
			root,
			"index.html",
			`<!doctype html><style>${".card{display:grid}".repeat(40)}</style><main>${"<section>inline</section>".repeat(30)}</main>`,
		);

		expect(assessProjectEntryConsistency(root)).toMatchObject({
			valid: false,
			errors: [expect.stringContaining("Build project entry conflict:")],
			sourceEntries: ["src/main.tsx"],
		});
	});

	it("accepts a React project whose root entry bootstraps the source implementation", () => {
		const root = project();
		write(root, "package.json", JSON.stringify({ scripts: { build: "vite build" } }));
		write(root, "src/main.tsx", "document.body.dataset.ready = 'true';");
		write(
			root,
			"index.html",
			'<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
		);

		expect(assessProjectEntryConsistency(root)).toMatchObject({ valid: true, errors: [] });
	});

	it("rejects a build-only source entry when the build manifest is missing", () => {
		const root = project();
		write(root, "src/main.tsx", "document.body.dataset.ready = 'true';");
		write(
			root,
			"index.html",
			'<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
		);

		expect(assessProjectEntryConsistency(root)).toMatchObject({
			valid: false,
			errors: [expect.stringContaining("Build project manifest missing:")],
			sourceEntries: ["src/main.tsx"],
		});
	});

	it("does not misclassify a build template without a second inline application", () => {
		const root = project();
		write(root, "package.json", JSON.stringify({ scripts: { build: "custom-build" } }));
		write(root, "src/index.jsx", "export default function App() { return <main>App</main>; }");
		write(root, "index.html", '<!doctype html><html><body><div id="root"></div></body></html>');

		expect(assessProjectEntryConsistency(root)).toMatchObject({ valid: true, errors: [] });
	});

	it("keeps dependency-free static apps on the direct root preview path", () => {
		const root = project();
		write(root, "index.html", "<!doctype html><main>Static</main>");

		expect(assessProjectEntryConsistency(root)).toMatchObject({ valid: true, errors: [] });
		expect(staticServeRootCandidates(false)[0]).toBe("");
		expect(staticServeRootCandidates(true)).toEqual(["dist", "build", "public"]);
	});
});

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-project-entry-"));
	roots.push(root);
	return root;
}

function write(root: string, path: string, content: string): void {
	const absolute = join(root, ...path.split("/"));
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content, "utf8");
}
