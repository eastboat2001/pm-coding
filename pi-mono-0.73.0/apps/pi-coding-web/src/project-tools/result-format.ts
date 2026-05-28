import type { ProjectFileDetails, ProjectTaskDetails } from "./schemas.js";

export type ProjectTaskResultFormatOptions = {
	activeSkillNames?: string[];
};

export function formatProjectFileResult(result: ProjectFileDetails): string {
	if (result.command === "list") return (result.files || []).join("\n") || "(no files)";
	if (result.command === "get") return result.content || "";
	return `${result.action || result.command}: ${result.filename}`;
}

export function formatProjectTaskResult(
	result: ProjectTaskDetails,
	options: ProjectTaskResultFormatOptions = {},
): string {
	return [
		`Task: ${result.task}`,
		`Status: ${result.status}`,
		result.mode ? `Mode: ${result.mode}` : "",
		result.previewUrl ? `Preview URL: ${result.previewUrl}` : "",
		result.projectRoot ? `Project root: ${result.projectRoot}` : "",
		result.serveRoot ? `Serve root: ${result.serveRoot}` : "",
		typeof result.fileCount === "number" ? `Files: ${result.fileCount}` : "",
		typeof result.valid === "boolean" ? `Valid: ${result.valid ? "yes" : "no"}` : "",
		result.errors?.length ? `Errors:\n${result.errors.join("\n")}` : "",
		result.files?.length ? `Project files:\n${result.files.join("\n")}` : "",
		result.logs?.length ? `\nLogs:\n${result.logs.join("").trim()}` : "",
		formatSkillAuditReminder(result, options.activeSkillNames),
	]
		.filter(Boolean)
		.join("\n");
}

function formatSkillAuditReminder(result: ProjectTaskDetails, activeSkillNames: string[] | undefined): string {
	if (result.task !== "preview" || !activeSkillNames?.length) return "";
	return [
		"",
		"Skill audit required before final response:",
		"Before finalizing, audit the generated project against all active selected skills:",
		...activeSkillNames.map((name) => `- ${name}`),
		"If any selected skill is not reflected in the current project, update the files and run preview again.",
	].join("\n");
}
