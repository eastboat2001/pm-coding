interface FileSystemHandlePermissionDescriptor {
	mode?: "read" | "readwrite";
}

interface FileSystemHandle {
	kind: "file" | "directory";
	name: string;
}

interface FileSystemFileHandle extends FileSystemHandle {
	kind: "file";
	getFile(): Promise<File>;
	createWritable(): Promise<FileSystemWritableFileStream>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
	kind: "directory";
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
	getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
	values(): AsyncIterable<FileSystemHandle>;
	queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
	requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemWritableFileStream {
	write(data: string | BufferSource | Blob): Promise<void>;
	close(): Promise<void>;
}

interface Window {
	showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
}
