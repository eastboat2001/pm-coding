const PROJECT_FILE_OMITTED_CONTENT_PATTERN =
	/\[project_file (?:content|get result) omitted: \d+ chars, \d+ lines from [^\]]+\]|Project file content omitted from compacted history for [^:]+: \d+ chars, \d+ lines\./;

export function isProjectFileOmittedContent(value: string): boolean {
	return PROJECT_FILE_OMITTED_CONTENT_PATTERN.test(value);
}

export function assertWritableProjectFileContent(value: string, filename: string): void {
	if (!isProjectFileOmittedContent(value)) return;
	throw new Error(
		`Refusing to write an omitted project_file placeholder to ${filename}. Call project_file get for ${filename} and provide the full current content before writing.`,
	);
}
