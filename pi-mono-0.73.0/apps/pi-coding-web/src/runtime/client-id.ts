const PI_CLIENT_ID_KEY = "pi.clientId";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getOrCreatePiClientId(storage: Storage = window.localStorage): string {
	const stored = storage.getItem(PI_CLIENT_ID_KEY);
	if (stored && UUID_PATTERN.test(stored)) {
		const normalized = stored.toLowerCase();
		if (normalized !== stored) storage.setItem(PI_CLIENT_ID_KEY, normalized);
		return normalized;
	}

	const clientId = crypto.randomUUID();
	storage.setItem(PI_CLIENT_ID_KEY, clientId);
	return clientId;
}

export function piClientHeaders(): Record<string, string> {
	return { "X-PI-Client-ID": getOrCreatePiClientId() };
}
