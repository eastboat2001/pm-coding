export type MonacoDisposableModel = {
	dispose(): void;
};

export type MonacoModelEditor<TModel extends MonacoDisposableModel> = {
	setModel(model: TModel | null): void;
};

export type MonacoModelRegistry<TModel extends MonacoDisposableModel, TUri> = {
	createModel(content: string, language: string, uri: TUri): TModel;
	getModel(uri: TUri): TModel | null;
};

export function replaceMonacoEditorModel<TModel extends MonacoDisposableModel, TUri>({
	registry,
	editor,
	currentModel,
	content,
	language,
	uri,
}: {
	registry: MonacoModelRegistry<TModel, TUri>;
	editor: MonacoModelEditor<TModel>;
	currentModel: TModel | null;
	content: string;
	language: string;
	uri: TUri;
}): TModel {
	const existingModel = registry.getModel(uri);
	if (currentModel) {
		editor.setModel(null);
		currentModel.dispose();
	}
	if (existingModel && existingModel !== currentModel) existingModel.dispose();

	const model = registry.createModel(content, language || "plaintext", uri);
	editor.setModel(model);
	return model;
}
