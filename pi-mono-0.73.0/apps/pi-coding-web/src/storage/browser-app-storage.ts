type BrowserAppStorage = {
	sessions: {
		getAllMetadata(): Promise<unknown[]>;
	};
};

let currentBrowserAppStorage: BrowserAppStorage | undefined;

export function setBrowserAppStorage(storage: BrowserAppStorage): void {
	currentBrowserAppStorage = storage;
}

export function getBrowserAppStorage(): BrowserAppStorage {
	if (!currentBrowserAppStorage) {
		throw new Error("Browser app storage not initialized.");
	}
	return currentBrowserAppStorage;
}
