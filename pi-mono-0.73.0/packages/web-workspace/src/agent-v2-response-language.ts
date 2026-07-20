export const AGENT_V2_RESPONSE_LANGUAGES = ["zh", "en", "de", "ms"] as const;

export type AgentV2ResponseLanguage = (typeof AGENT_V2_RESPONSE_LANGUAGES)[number];

export function normalizeAgentV2ResponseLanguage(value: unknown): AgentV2ResponseLanguage | undefined {
	return AGENT_V2_RESPONSE_LANGUAGES.find((language) => language === value);
}

export function inferAgentV2ResponseLanguage(input: unknown, fallback: unknown = "en"): AgentV2ResponseLanguage {
	const record = isRecord(input) ? input : {};
	const explicit = normalizeAgentV2ResponseLanguage(record.responseLanguage);
	if (explicit) return explicit;

	const conversationSnapshot = isRecord(record.conversationSnapshot) ? record.conversationSnapshot : undefined;
	const candidates: string[] = [];
	if (typeof record.objective === "string") candidates.push(record.objective);
	if (conversationSnapshot && Array.isArray(conversationSnapshot.recentMessages)) {
		for (const message of [...conversationSnapshot.recentMessages].reverse()) {
			if (!isRecord(message) || message.role !== "user" || typeof message.content !== "string") continue;
			candidates.push(message.content);
		}
	}
	for (const candidate of candidates) {
		const detected = detectResponseLanguage(candidate);
		if (detected) return detected;
	}
	return normalizeLocaleLanguage(fallback) ?? "en";
}

function detectResponseLanguage(value: string): AgentV2ResponseLanguage | undefined {
	if (/\p{Script=Han}/u.test(value)) return "zh";
	const words = new Set(value.toLocaleLowerCase("en-US").match(/\p{Letter}+/gu) ?? []);
	const score = (markers: readonly string[]) => markers.filter((marker) => words.has(marker)).length;
	if (/[äöüß]/iu.test(value) || score(["der", "die", "das", "und", "bitte", "erstellen", "anwendung"]) >= 2) {
		return "de";
	}
	if (score(["yang", "dan", "untuk", "dengan", "saya", "anda", "bina", "aplikasi"]) >= 2) return "ms";
	if (/[A-Za-z]/u.test(value)) return "en";
	return undefined;
}

function normalizeLocaleLanguage(value: unknown): AgentV2ResponseLanguage | undefined {
	if (typeof value !== "string") return undefined;
	return normalizeAgentV2ResponseLanguage(value.trim().toLocaleLowerCase("en-US").split(/[-_]/u)[0]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
