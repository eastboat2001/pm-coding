import { describe, expect, it } from "vitest";
import { replaceMonacoEditorModel } from "../src/app/monaco-model-state.js";

class FakeModel {
	disposed = false;

	constructor(
		readonly id: number,
		private readonly uri: string,
		private readonly registry: Map<string, FakeModel>,
		private readonly events: string[],
	) {}

	dispose(): void {
		this.disposed = true;
		this.events.push(`dispose:${this.id}`);
		if (this.registry.get(this.uri) === this) this.registry.delete(this.uri);
	}
}

describe("monaco model state", () => {
	it("disposes the current URI model before recreating it for a reset", () => {
		const events: string[] = [];
		const models = new Map<string, FakeModel>();
		let nextId = 1;
		const registry = {
			getModel(uri: string): FakeModel | null {
				return models.get(uri) || null;
			},
			createModel(_content: string, _language: string, uri: string): FakeModel {
				if (models.has(uri)) throw new Error("ModelService: Cannot add model because it already exists!");
				const model = new FakeModel(nextId++, uri, models, events);
				models.set(uri, model);
				events.push(`create:${model.id}`);
				return model;
			},
		};
		const editor = {
			setModel(model: FakeModel | null): void {
				events.push(model ? `set:${model.id}` : "clear");
			},
		};

		const first = replaceMonacoEditorModel({
			registry,
			editor,
			currentModel: null,
			content: "<html></html>",
			language: "html",
			uri: "pi-project:///index.html",
		});
		const second = replaceMonacoEditorModel({
			registry,
			editor,
			currentModel: first,
			content: "<html lang=\"zh-CN\"></html>",
			language: "html",
			uri: "pi-project:///index.html",
		});

		expect(second).not.toBe(first);
		expect(first.disposed).toBe(true);
		expect(events).toEqual(["create:1", "set:1", "clear", "dispose:1", "create:2", "set:2"]);
	});
});
