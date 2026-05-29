export type SkillDiagnosticType = "error" | "warning" | "collision";

export interface SkillDiagnostic {
	type: SkillDiagnosticType;
	message: string;
	path?: string;
}

export interface SkillDiagnosticCounts {
	error: number;
	warning: number;
	collision: number;
	total: number;
}

export function countSkillDiagnostics(diagnostics: readonly SkillDiagnostic[]): SkillDiagnosticCounts {
	const counts: SkillDiagnosticCounts = { error: 0, warning: 0, collision: 0, total: diagnostics.length };
	for (const diagnostic of diagnostics) {
		counts[diagnostic.type] += 1;
	}
	return counts;
}

export function highestSkillDiagnosticType(diagnostics: readonly SkillDiagnostic[]): SkillDiagnosticType | undefined {
	const counts = countSkillDiagnostics(diagnostics);
	if (counts.error > 0) return "error";
	if (counts.warning > 0) return "warning";
	if (counts.collision > 0) return "collision";
	return undefined;
}

export function formatSkillDiagnosticDetail(diagnostic: SkillDiagnostic): string {
	return [diagnostic.message, diagnostic.path ? `Path: ${diagnostic.path}` : ""].filter(Boolean).join("\n\n");
}
