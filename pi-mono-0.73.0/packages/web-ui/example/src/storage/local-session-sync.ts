import type { Model } from "@mariozechner/pi-ai";
import type { SessionData, SessionMetadata, SettingsStore } from "@mariozechner/pi-web-ui";
import {
	parseLocalSettings,
	parseSessionRecord,
	serializeLocalSettings,
	serializeSessionRecord,
} from "./session-file-codec.js";

const DIRECTORY_HANDLE_KEY = "example.localSync.directoryHandle";
const ENABLED_KEY = "example.localSync.enabled";
const LAST_ERROR_KEY = "example.localSync.lastError";

export interface LocalSyncStatus {
	supported: boolean;
	enabled: boolean;
	hasDirectory: boolean;
	directoryName: string | null;
	lastError: string | null;
}

type PickerWindow = Window & {
	showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
};

export class LocalSessionSync {
	constructor(private readonly settings: SettingsStore) {}

	isSupported(): boolean {
		return typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";
	}

	async isEnabled(): Promise<boolean> {
		return (await this.settings.get<boolean>(ENABLED_KEY)) === true;
	}

	async setEnabled(enabled: boolean): Promise<void> {
		await this.settings.set(ENABLED_KEY, enabled);
	}

	async getLastError(): Promise<string | null> {
		return await this.settings.get<string>(LAST_ERROR_KEY);
	}

	async getStatus(): Promise<LocalSyncStatus> {
		const handle = await this.getDirectoryHandle();
		return {
			supported: this.isSupported(),
			enabled: await this.isEnabled(),
			hasDirectory: !!handle,
			directoryName: handle?.name ?? null,
			lastError: await this.getLastError(),
		};
	}

	private async setLastError(message?: string): Promise<void> {
		if (message) {
			await this.settings.set(LAST_ERROR_KEY, message);
		} else {
			await this.settings.delete(LAST_ERROR_KEY);
		}
	}

	async getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
		return await this.settings.get<FileSystemDirectoryHandle>(DIRECTORY_HANDLE_KEY);
	}

	private async setDirectoryHandle(handle: FileSystemDirectoryHandle | null): Promise<void> {
		if (handle) {
			await this.settings.set(DIRECTORY_HANDLE_KEY, handle);
		} else {
			await this.settings.delete(DIRECTORY_HANDLE_KEY);
		}
	}

	private async verifyPermission(handle: FileSystemDirectoryHandle, readwrite = false): Promise<boolean> {
		const options = { mode: readwrite ? "readwrite" : "read" } as const;
		if (handle.queryPermission && (await handle.queryPermission(options)) === "granted") {
			return true;
		}
		if (handle.requestPermission) {
			return (await handle.requestPermission(options)) === "granted";
		}
		return false;
	}

	async pickDirectory(): Promise<boolean> {
		if (!this.isSupported()) return false;
		try {
			const handle = await (window as PickerWindow).showDirectoryPicker!();
			const granted = await this.verifyPermission(handle, true);
			if (!granted) {
				await this.setLastError("Directory permission denied.");
				return false;
			}
			await this.setDirectoryHandle(handle);
			await this.setEnabled(true);
			await this.setLastError();
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.setLastError(message);
			return false;
		}
	}

	async disable(): Promise<void> {
		await this.setEnabled(false);
		await this.setLastError();
	}

	async clearDirectory(): Promise<void> {
		await this.setEnabled(false);
		await this.setDirectoryHandle(null);
		await this.setLastError();
	}

	private async getWritableRoot(): Promise<FileSystemDirectoryHandle | null> {
		const enabled = await this.isEnabled();
		if (!enabled) return null;
		const handle = await this.getDirectoryHandle();
		if (!handle) return null;
		const granted = await this.verifyPermission(handle, true);
		if (!granted) {
			await this.setLastError("Local sync directory permission denied.");
			return null;
		}
		return handle;
	}

	private async getReadableRoot(): Promise<FileSystemDirectoryHandle | null> {
		const handle = await this.getDirectoryHandle();
		if (!handle) return null;
		const granted = await this.verifyPermission(handle, false);
		if (!granted) {
			await this.setLastError("Local sync directory permission denied.");
			return null;
		}
		return handle;
	}

	private async getSessionsDirectory(
		root: FileSystemDirectoryHandle,
		create = false,
	): Promise<FileSystemDirectoryHandle> {
		return await root.getDirectoryHandle("sessions", { create });
	}

	async writeSession(data: SessionData, metadata: SessionMetadata): Promise<void> {
		const root = await this.getWritableRoot();
		if (!root) return;
		try {
			const dir = await this.getSessionsDirectory(root, true);
			const file = await dir.getFileHandle(`${data.id}.json`, { create: true });
			const writable = await file.createWritable();
			await writable.write(serializeSessionRecord(data, metadata));
			await writable.close();
			await this.setLastError();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.setLastError(message);
		}
	}

	async deleteSession(sessionId: string): Promise<void> {
		const root = await this.getWritableRoot();
		if (!root) return;
		try {
			const dir = await this.getSessionsDirectory(root, false);
			await dir.removeEntry(`${sessionId}.json`);
			await this.setLastError();
		} catch {
			// Ignore missing files.
		}
	}

	async readSession(sessionId: string): Promise<{ data: SessionData; metadata: SessionMetadata } | null> {
		const root = await this.getReadableRoot();
		if (!root) return null;
		try {
			const dir = await this.getSessionsDirectory(root, false);
			const fileHandle = await dir.getFileHandle(`${sessionId}.json`);
			const file = await fileHandle.getFile();
			const json = await file.text();
			const record = parseSessionRecord(json);
			await this.setLastError();
			return { data: record.data, metadata: record.metadata };
		} catch {
			return null;
		}
	}

	async listSessionMetadata(): Promise<SessionMetadata[]> {
		const root = await this.getReadableRoot();
		if (!root) return [];
		try {
			const dir = await this.getSessionsDirectory(root, false);
			const result: SessionMetadata[] = [];
			for await (const handle of dir.values()) {
				if (handle.kind !== "file") continue;
				const file = await (handle as FileSystemFileHandle).getFile();
				const record = parseSessionRecord(await file.text());
				result.push(record.metadata);
			}
			await this.setLastError();
			return result.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
		} catch {
			return [];
		}
	}

	async writeSettings(settingsData: { currentSessionId?: string; selectedModel?: Model<any> }): Promise<void> {
		const root = await this.getWritableRoot();
		if (!root) return;
		try {
			const file = await root.getFileHandle("settings.json", { create: true });
			const writable = await file.createWritable();
			await writable.write(serializeLocalSettings(settingsData));
			await writable.close();
			await this.setLastError();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.setLastError(message);
		}
	}

	async readSettings(): Promise<{ currentSessionId?: string; selectedModel?: Model<any> } | null> {
		const root = await this.getReadableRoot();
		if (!root) return null;
		try {
			const fileHandle = await root.getFileHandle("settings.json");
			const file = await fileHandle.getFile();
			const record = parseLocalSettings(await file.text());
			await this.setLastError();
			return {
				currentSessionId: record.currentSessionId,
				selectedModel: record.selectedModel,
			};
		} catch {
			return null;
		}
	}
}
