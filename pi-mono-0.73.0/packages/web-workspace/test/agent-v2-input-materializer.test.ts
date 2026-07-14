import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentV2InputBlobRecord, AgentV2InputReferenceRecord } from "../src/agent-v2-durable-store.js";
import {
	AgentV2InputMaterializationError,
	DurableAgentV2InputMaterializer,
} from "../src/agent-v2-input-materializer.js";
import { normalizeAgentV2StartInput } from "../src/agent-v2-start-input.js";
import type { AgentV2RunSnapshot } from "../src/agent-v2-types.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "run-materializer";
const CREATED_AT = "2026-07-14T00:00:00.000Z";

describe("DurableAgentV2InputMaterializer", () => {
	it("returns a deterministic empty result without reading blobs", async () => {
		const store = fakeStore([], new Map());
		const materializer = new DurableAgentV2InputMaterializer(store);

		await expect(
			materializer.materialize({ run: runWith([]), signal: new AbortController().signal }),
		).resolves.toEqual([]);
		expect(store.listAgentV2InputReferences).toHaveBeenCalledWith(CLIENT_ID, RUN_ID);
		expect(store.readAgentV2InputBlob).not.toHaveBeenCalled();
	});

	it("ignores store order and reads a shared attachment blob exactly once", async () => {
		const text = bytes("alpha");
		const image = pngBytes();
		const project = reference("project_file", 0, "text", "src/a.txt", text);
		const imageBacking = reference("project_file", 1, "image", "assets/a.png", image);
		const attachment = reference("attachment", 0, "image", "assets/a.png", image, "a.png");
		const committed = [attachment, imageBacking, project];
		const blobs = new Map([
			[project.inputId, blob(project, text, "utf8")],
			[imageBacking.inputId, blob(imageBacking, image, "binary")],
		]);
		const firstStore = fakeStore([project, imageBacking, attachment], blobs);
		const secondStore = fakeStore([attachment, project, imageBacking], blobs);

		const first = await new DurableAgentV2InputMaterializer(firstStore).materialize({
			run: runWith(committed),
			signal: new AbortController().signal,
		});
		const second = await new DurableAgentV2InputMaterializer(secondStore).materialize({
			run: runWith(committed),
			signal: new AbortController().signal,
		});

		expect(first).toEqual(second);
		expect(first.map((entry) => [entry.kind, entry.reference.kind, entry.reference.inputId])).toEqual([
			["text", "project_file", "text"],
			["image", "attachment", "image"],
		]);
		expect(firstStore.readAgentV2InputBlob).toHaveBeenCalledTimes(2);
	});

	it.each([
		["missing", (_ref: AgentV2InputReferenceRecord) => []],
		["extra", (ref: AgentV2InputReferenceRecord) => [ref, { ...ref, ordinal: 1, inputId: "extra" }]],
		["duplicate", (ref: AgentV2InputReferenceRecord) => [ref, ref]],
		["cross-client", (ref: AgentV2InputReferenceRecord) => [{ ...ref, clientId: "other-client" }]],
		["cross-run", (ref: AgentV2InputReferenceRecord) => [{ ...ref, runId: "other-run" }]],
	])("fails closed for %s durable references", async (_name, mutate) => {
		const content = bytes("authorized");
		const ref = reference("project_file", 0, "text", "a.txt", content);
		const store = fakeStore(mutate(ref), new Map([[ref.inputId, blob(ref, content, "utf8")]]));

		await expect(materialize(store, [ref])).rejects.toMatchObject({ code: "authorization_mismatch" });
		expect(store.readAgentV2InputBlob).not.toHaveBeenCalled();
	});

	it("rejects missing, cross-run, and checksum-changed blobs with sanitized errors", async () => {
		const content = bytes("authorized");
		const ref = reference("project_file", 0, "text", "a.txt", content);
		const missing = fakeStore([ref], new Map());
		await expect(materialize(missing, [ref])).rejects.toMatchObject({ code: "missing_blob" });

		const wrongIdentity = blob(ref, content, "utf8");
		wrongIdentity.runId = "other-run";
		await expect(materialize(fakeStore([ref], new Map([[ref.inputId, wrongIdentity]])), [ref])).rejects.toMatchObject(
			{
				code: "corrupt_blob",
			},
		);

		const changed = blob(ref, bytes("changed"), "utf8");
		await expect(materialize(fakeStore([ref], new Map([[ref.inputId, changed]])), [ref])).rejects.toMatchObject({
			code: "integrity_mismatch",
		});
	});

	it("accepts strict UTF-8 and rejects invalid UTF-8 or spoofed image metadata", async () => {
		const unicode = bytes("你好, v2 🚀");
		const textRef = reference("project_file", 0, "text", "unicode.txt", unicode);
		const [text] = await materialize(
			fakeStore([textRef], new Map([[textRef.inputId, blob(textRef, unicode, "utf8")]])),
			[textRef],
		);
		expect(text).toMatchObject({ kind: "text", text: "你好, v2 🚀" });

		const invalid = new Uint8Array([0xc3, 0x28]);
		const invalidRef = reference("project_file", 0, "invalid", "invalid.txt", invalid, undefined, "text/plain");
		await expect(
			materialize(fakeStore([invalidRef], new Map([[invalidRef.inputId, blob(invalidRef, invalid, "utf8")]])), [
				invalidRef,
			]),
		).rejects.toMatchObject({ code: "unsupported_media" });

		const spoofed = bytes("not an image");
		const spoofedRef = reference("attachment", 0, "spoof", "fake.png", spoofed, "fake.png", "image/png");
		await expect(
			materialize(fakeStore([spoofedRef], new Map([[spoofedRef.inputId, blob(spoofedRef, spoofed, "binary")]])), [
				spoofedRef,
			]),
		).rejects.toMatchObject({ code: "unsupported_media" });
	});

	it("materializes a start-normalized image attachment once while rejecting a standalone binary project file", async () => {
		const image = pngBytes();
		const normalized = normalizeAgentV2StartInput(
			{
				input: {
					sessionId: "session",
					title: "Image",
					objective: "Use the committed image",
					projectFiles: [
						{ filename: "assets/logo.png", content: Buffer.from(image).toString("base64"), encoding: "base64" },
					],
					attachments: [
						{ type: "image", fileName: "logo.png", mimeType: "image/png", projectFilePath: "assets/logo.png" },
					],
				},
				model: { provider: "test", id: "model" },
			},
			{ clientId: CLIENT_ID, runId: RUN_ID, createdAt: CREATED_AT },
		);
		const store = fakeStore(
			normalized.inputReferences,
			new Map(normalized.inputBlobs.map((item) => [item.inputId, item])),
		);

		const result = await materialize(store, normalized.inputReferences, normalized.runInput);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ kind: "image", reference: { kind: "attachment" }, mediaType: "image/png" });
		expect(store.readAgentV2InputBlob).toHaveBeenCalledTimes(1);

		const backing = normalized.inputReferences.find((item) => item.kind === "project_file");
		expect(backing).toBeDefined();
		await expect(
			materialize(fakeStore([backing!], new Map(normalized.inputBlobs.map((item) => [item.inputId, item]))), [
				backing!,
			]),
		).rejects.toMatchObject({ code: "unsupported_media" });
	});

	it("deduplicates shared text content with attachment semantics while preserving standalone project text", async () => {
		const shared = bytes("shared text");
		const standalone = bytes("standalone text");
		const backing = reference("project_file", 0, "shared-text", "shared.txt", shared);
		const attachment = reference("attachment", 0, "shared-text", "shared.txt", shared, "shared.txt");
		const project = reference("project_file", 1, "standalone-text", "standalone.txt", standalone);
		const store = fakeStore(
			[attachment, project, backing],
			new Map([
				[backing.inputId, blob(backing, shared, "utf8")],
				[project.inputId, blob(project, standalone, "utf8")],
			]),
		);

		const result = await materialize(store, [backing, project, attachment]);
		expect(result).toMatchObject([
			{ kind: "text", reference: { kind: "project_file", inputId: "standalone-text" }, text: "standalone text" },
			{ kind: "text", reference: { kind: "attachment", inputId: "shared-text" }, text: "shared text" },
		]);
		expect(store.readAgentV2InputBlob).toHaveBeenCalledTimes(2);
	});

	it("settles promptly when aborted while the durable list is pending", async () => {
		const controller = new AbortController();
		let settleList!: (value: AgentV2InputReferenceRecord[]) => void;
		const pending = new Promise<AgentV2InputReferenceRecord[]>((resolve) => {
			settleList = resolve;
		});
		const store = {
			listAgentV2InputReferences: vi.fn(() => pending),
			readAgentV2InputBlob: vi.fn(),
		};
		const result = new DurableAgentV2InputMaterializer(store).materialize({
			run: runWith([]),
			signal: controller.signal,
		});
		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		settleList([]);
		expect(store.readAgentV2InputBlob).not.toHaveBeenCalled();
	});

	it("never exposes raw store failures and returns copies that callers cannot use to poison retries", async () => {
		const sentinel = "RAW_STORE_SECRET_SENTINEL";
		const failingStore = {
			listAgentV2InputReferences: vi.fn(() => Promise.reject(new Error(sentinel))),
			readAgentV2InputBlob: vi.fn(),
		};
		let failure: unknown;
		try {
			await new DurableAgentV2InputMaterializer(failingStore).materialize({
				run: runWith([]),
				signal: new AbortController().signal,
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AgentV2InputMaterializationError);
		expect(
			`${String(failure)}\n${failure instanceof Error ? failure.stack : ""}\n${JSON.stringify(failure)}`,
		).not.toContain(sentinel);

		const image = pngBytes();
		const ref = reference("attachment", 0, "image", "image.png", image, "image.png");
		const store = fakeStore([ref], new Map([[ref.inputId, blob(ref, image, "binary")]]));
		const first = await materialize(store, [ref]);
		expect(first[0]?.kind).toBe("image");
		if (first[0]?.kind === "image") first[0].data[0] = 0;
		const second = await materialize(store, [ref]);
		expect(second[0]?.kind === "image" ? second[0].data[0] : undefined).toBe(0x89);
	});

	it("snapshots a mutable store buffer and never executes hostile record getters", async () => {
		const image = pngBytes();
		const ref = reference("attachment", 0, "snapshot", "snapshot.png", image, "snapshot.png");
		const storedBlob = blob(ref, image, "binary");
		const first = await materialize(fakeStore([ref], new Map([[ref.inputId, storedBlob]])), [ref]);
		image[0] = 0;
		expect(first[0]?.kind === "image" ? first[0].data[0] : undefined).toBe(0x89);

		const getter = vi.fn(() => "must-not-run");
		const hostileReference = { ...ref };
		Object.defineProperty(hostileReference, "logicalPath", { enumerable: true, get: getter });
		await expect(materialize(fakeStore([hostileReference], new Map()), [ref])).rejects.toMatchObject({
			code: "authorization_mismatch",
		});
		expect(getter).not.toHaveBeenCalled();
	});

	it("bounds the real typed-array backing view before copying or hashing", async () => {
		const tiny = new Uint8Array([0]);
		const ref = reference("attachment", 0, "shadowed", "shadowed.png", tiny, "shadowed.png", "image/png");
		const shadowed = new Uint8Array(3 * 1_048_576);
		Object.defineProperties(shadowed, {
			byteLength: { configurable: true, value: 1 },
			byteOffset: { configurable: true, value: 0 },
			buffer: { configurable: true, value: new ArrayBuffer(1) },
		});
		const hostileBlob = { ...blob(ref, tiny, "binary"), bytes: shadowed };
		await expect(materialize(fakeStore([ref], new Map([[ref.inputId, hostileBlob]])), [ref])).rejects.toMatchObject({
			code: "limit_exceeded",
		});

		const buffer = Buffer.from("buffer input", "utf8");
		const bufferRef = reference("project_file", 0, "buffer", "buffer.txt", buffer);
		await expect(
			materialize(fakeStore([bufferRef], new Map([[bufferRef.inputId, blob(bufferRef, buffer, "utf8")]])), [
				bufferRef,
			]),
		).resolves.toMatchObject([{ kind: "text", text: "buffer input" }]);

		const detached = new Uint8Array([1, 2, 3]);
		const detachedRef = reference("attachment", 0, "detached", "detached.png", detached, "detached.png", "image/png");
		const detachedBlob = blob(detachedRef, detached, "binary");
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		await expect(
			materialize(fakeStore([detachedRef], new Map([[detachedRef.inputId, detachedBlob]])), [detachedRef]),
		).rejects.toMatchObject({ code: "corrupt_blob" });

		const shared = new Uint8Array(new SharedArrayBuffer(64));
		const sharedRef = reference("attachment", 0, "shared", "shared.png", shared, "shared.png", "image/png");
		await expect(
			materialize(fakeStore([sharedRef], new Map([[sharedRef.inputId, blob(sharedRef, shared, "binary")]])), [
				sharedRef,
			]),
		).rejects.toMatchObject({ code: "corrupt_blob" });

		const proxied = new Proxy(new Uint8Array([1]), {});
		const proxyRef = reference("attachment", 0, "proxy", "proxy.png", tiny, "proxy.png", "image/png");
		await expect(
			materialize(
				fakeStore([proxyRef], new Map([[proxyRef.inputId, { ...blob(proxyRef, tiny, "binary"), bytes: proxied }]])),
				[proxyRef],
			),
		).rejects.toMatchObject({ code: "corrupt_blob" });
	});

	it("compares every durable reference metadata field against the committed authorization", async () => {
		const content = bytes("metadata");
		const committed = reference("attachment", 0, "metadata", "notes.txt", content, "notes.txt");
		const mutations: AgentV2InputReferenceRecord[] = [
			{ ...committed, kind: "project_file", displayName: undefined } as AgentV2InputReferenceRecord,
			{ ...committed, ordinal: 1 },
			{ ...committed, inputId: "changed-input" },
			{ ...committed, logicalPath: "changed.txt" },
			{ ...committed, displayName: "changed.txt" },
			{ ...committed, mediaType: "application/json" },
			{ ...committed, byteLength: committed.byteLength + 1 },
			{ ...committed, checksum: `sha256:${"0".repeat(64)}` },
		];
		for (const durable of mutations) {
			const store = fakeStore([durable], new Map([[committed.inputId, blob(committed, content, "utf8")]]));
			await expect(materialize(store, [committed])).rejects.toMatchObject({ code: "authorization_mismatch" });
			expect(store.readAgentV2InputBlob).not.toHaveBeenCalled();
		}
	});

	it("checks blob metadata and recomputed integrity independently", async () => {
		const content = bytes("blob metadata");
		const ref = reference("project_file", 0, "blob", "blob.txt", content);
		const valid = blob(ref, content, "utf8");
		const corruptions: Array<[Partial<AgentV2InputBlobRecord>, string]> = [
			[{ logicalPath: "changed.txt" }, "integrity_mismatch"],
			[{ mediaType: "application/json" }, "integrity_mismatch"],
			[{ byteLength: valid.byteLength + 1 }, "integrity_mismatch"],
			[{ checksum: `sha256:${"0".repeat(64)}` }, "integrity_mismatch"],
			[{ encoding: "binary" }, "unsupported_media"],
		];
		for (const [mutation, code] of corruptions) {
			await expect(
				materialize(fakeStore([ref], new Map([[ref.inputId, { ...valid, ...mutation }]])), [ref]),
			).rejects.toMatchObject({ code });
		}
		const changedBytes = bytes("changed bytes");
		await expect(
			materialize(
				fakeStore(
					[ref],
					new Map([[ref.inputId, { ...valid, bytes: changedBytes, byteLength: changedBytes.byteLength }]]),
				),
				[ref],
			),
		).rejects.toMatchObject({ code: "integrity_mismatch" });
	});

	it.each([
		["image/png", pngBytes()],
		["image/png", pngWithChunkAfterIhdr("ruSt", new Uint8Array([1]))],
		["image/png", indexedPngWithValidPlte()],
		["image/jpeg", jpegBytes()],
		["image/jpeg", progressiveJpegBytes()],
		["image/jpeg", jpegScanMarkerExerciseBytes()],
		["image/webp", vp8WebpBytes()],
		["image/webp", webpBytes()],
		["image/webp", extendedWebpBytes()],
		["image/webp", encodedVp8xAlphaWebpBytes()],
		["image/webp", animatedWebpBytes()],
	] as const)("accepts a sniffed %s attachment", async (mediaType, content) => {
		const ref = reference("attachment", 0, mediaType, `asset.${mediaType.slice(6)}`, content, "asset", mediaType);
		const result = await materialize(fakeStore([ref], new Map([[ref.inputId, blob(ref, content, "binary")]])), [ref]);
		expect(result[0]).toMatchObject({ kind: "image", mediaType });
	});

	it.each([
		["truncated PNG signature", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), "image/png"],
		["truncated JPEG marker", new Uint8Array([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"],
		[
			"truncated WebP shell",
			new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
			"image/webp",
		],
		["PNG zero width", mutatePngWidth(pngBytes(), 0), "image/png"],
		["PNG without IDAT", pngWithoutIdat(), "image/png"],
		["PNG with only an empty IDAT", pngWithEmptyIdat(), "image/png"],
		["PNG with non-contiguous IDAT chunks", pngWithNonContiguousIdat(), "image/png"],
		["PNG with an unknown critical chunk", pngWithChunkAfterIhdr("ABCD", new Uint8Array([1])), "image/png"],
		["PNG with a lowercase reserved chunk-type bit", pngWithChunkAfterIhdr("rust", new Uint8Array([1])), "image/png"],
		["PNG with PLTE after IDAT", pngWithPlteAfterIdat(), "image/png"],
		["PNG with duplicate PLTE chunks", pngWithDuplicatePlte(), "image/png"],
		["grayscale PNG with forbidden PLTE", grayscalePngWithPlte(), "image/png"],
		["indexed PNG without required PLTE", indexedPngWithoutPlte(), "image/png"],
		["indexed PNG with too many palette entries for its bit depth", indexedPngWithOversizedPlte(), "image/png"],
		["JPEG without SOS", jpegWithoutSos(), "image/jpeg"],
		["JPEG with an empty entropy scan", jpegWithEmptyScan(), "image/jpeg"],
		["JPEG with only a restart marker in its entropy scan", jpegWithRestartOnlyScan(), "image/jpeg"],
		["JPEG with a restart marker outside entropy", jpegWithRestartOutsideScan(), "image/jpeg"],
		["JPEG with an SOI marker confused for entropy", jpegWithMarkerInsideScan(), "image/jpeg"],
		["JPEG with a truncated SOS header", jpegWithTruncatedScanHeader(), "image/jpeg"],
		["JPEG segment overrun", new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff, 0xff, 0xd9]), "image/jpeg"],
		["WebP RIFF length overrun", mutateWebpRiffSize(webpBytes(), 0xffff_ffff), "image/webp"],
		["simple WebP with only a VP8 frame header", headerOnlyVp8WebpBytes(), "image/webp"],
		["simple WebP with a hidden VP8 key frame", invalidVp8FrameWebpBytes("hidden"), "image/webp"],
		["simple WebP with a VP8 inter frame", invalidVp8FrameWebpBytes("inter"), "image/webp"],
		["simple WebP with an overrun VP8 first partition", invalidVp8FrameWebpBytes("partition"), "image/webp"],
		["simple WebP with only a VP8L header", headerOnlyVp8lWebpBytes(), "image/webp"],
		["WebP VP8X shell without image payload", vp8xOnlyWebpBytes(), "image/webp"],
		["WebP VP8X with only a VP8L header", extendedHeaderOnlyWebpBytes(), "image/webp"],
		["WebP animation frame with only a VP8L header", animatedHeaderOnlyWebpBytes(), "image/webp"],
		["WebP with too few raw alpha samples", shortRawAlphaWebpBytes(), "image/webp"],
		["WebP with reserved ALPH flags", invalidAlphaWebpBytes(0x40, 4), "image/webp"],
		["WebP with invalid ALPH preprocessing", invalidAlphaWebpBytes(0x20, 4), "image/webp"],
		["WebP with an empty compressed ALPH payload", invalidAlphaWebpBytes(0x01, 0), "image/webp"],
		["WebP with non-zero odd-chunk padding", webpWithNonzeroPadding(), "image/webp"],
		["WebP animation chunks without the VP8X animation flag", animatedWebpBytes(0), "image/webp"],
		["WebP with duplicate primary image chunks", duplicatePrimaryWebpBytes(), "image/webp"],
		["WebP animation frame before ANIM", misorderedAnimatedWebpBytes(), "image/webp"],
		["WebP VP8X with reserved feature flags", extendedWebpBytes(0x80), "image/webp"],
	] as const)("rejects structurally invalid %s", async (_name, content, mediaType) => {
		const ref = reference("attachment", 0, "invalid-image", "invalid.bin", content, "invalid.bin", mediaType);
		await expect(
			materialize(fakeStore([ref], new Map([[ref.inputId, blob(ref, content, "binary")]])), [ref]),
		).rejects.toMatchObject({ code: "unsupported_media" });
	});

	it("requires blob createdAt to be the canonical committed run creation timestamp", async () => {
		const content = bytes("created at");
		const ref = reference("project_file", 0, "created-at", "created-at.txt", content);
		const valid = blob(ref, content, "utf8");
		for (const createdAt of ["x", "2026-07-14T00:00:00Z", "2026-07-14T00:00:00.001Z"]) {
			await expect(
				materialize(fakeStore([ref], new Map([[ref.inputId, { ...valid, createdAt }]])), [ref]),
			).rejects.toMatchObject({ code: "corrupt_blob" });
		}
		await expect(
			new DurableAgentV2InputMaterializer(fakeStore([ref], new Map([[ref.inputId, valid]]))).materialize({
				run: { ...runWith([ref]), createdAt: "2026-07-14T00:00:00Z" },
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "authorization_mismatch" });
	});

	it("enforces entry, per-file, and aggregate limits at exact boundaries", async () => {
		const maxEntries = Array.from({ length: 64 }, (_, ordinal) => {
			const content = new Uint8Array();
			return reference("project_file", ordinal, `empty-${ordinal}`, `empty-${ordinal}.txt`, content);
		});
		const emptyBlobMap = new Map(
			maxEntries.map((ref) => [ref.inputId, blob(ref, new Uint8Array(), "utf8")] as const),
		);
		await expect(materialize(fakeStore(maxEntries, emptyBlobMap), maxEntries)).resolves.toHaveLength(64);
		const overEntries = [...maxEntries, reference("project_file", 0, "overflow", "overflow.txt", new Uint8Array())];
		await expect(materialize(fakeStore(overEntries, emptyBlobMap), overEntries)).rejects.toMatchObject({
			code: "limit_exceeded",
		});

		const exactText = new Uint8Array(1_048_576).fill(0x61);
		const exactTextRef = reference("project_file", 0, "exact-text", "exact.txt", exactText);
		await expect(
			materialize(
				fakeStore([exactTextRef], new Map([[exactTextRef.inputId, blob(exactTextRef, exactText, "utf8")]])),
				[exactTextRef],
			),
		).resolves.toHaveLength(1);
		const overText = new Uint8Array(1_048_577).fill(0x61);
		const overTextRef = reference("project_file", 0, "over-text", "over.txt", overText);
		await expect(
			materialize(fakeStore([overTextRef], new Map([[overTextRef.inputId, blob(overTextRef, overText, "utf8")]])), [
				overTextRef,
			]),
		).rejects.toMatchObject({ code: "limit_exceeded" });
		const overImage = sizedPng(2_097_153, 0);
		const overImageRef = reference("attachment", 0, "over-image", "over.png", overImage, "over.png");
		await expect(
			materialize(
				fakeStore([overImageRef], new Map([[overImageRef.inputId, blob(overImageRef, overImage, "binary")]])),
				[overImageRef],
			),
		).rejects.toMatchObject({ code: "limit_exceeded" });

		const aggregateRefs: AgentV2InputReferenceRecord[] = [];
		const aggregateBlobs = new Map<string, AgentV2InputBlobRecord>();
		for (let ordinal = 0; ordinal < 4; ordinal += 1) {
			const content = sizedPng(2_097_152, ordinal);
			const ref = reference(
				"attachment",
				ordinal,
				`aggregate-${ordinal}`,
				`aggregate-${ordinal}.png`,
				content,
				`${ordinal}.png`,
			);
			aggregateRefs.push(ref);
			aggregateBlobs.set(ref.inputId, blob(ref, content, "binary"));
		}
		await expect(materialize(fakeStore(aggregateRefs, aggregateBlobs), aggregateRefs)).resolves.toHaveLength(4);
		const oneByte = bytes("x");
		const overflow = reference("project_file", 4, "aggregate-overflow", "overflow.txt", oneByte);
		aggregateRefs.push(overflow);
		aggregateBlobs.set(overflow.inputId, blob(overflow, oneByte, "utf8"));
		await expect(materialize(fakeStore(aggregateRefs, aggregateBlobs), aggregateRefs)).rejects.toMatchObject({
			code: "limit_exceeded",
		});
	});

	it("aborts before list, between list and blob, and while a blob read is pending", async () => {
		const before = new AbortController();
		before.abort();
		const beforeStore = fakeStore([], new Map());
		await expect(
			new DurableAgentV2InputMaterializer(beforeStore).materialize({ run: runWith([]), signal: before.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(beforeStore.listAgentV2InputReferences).not.toHaveBeenCalled();

		const content = bytes("abort");
		const ref = reference("project_file", 0, "abort", "abort.txt", content);
		const between = new AbortController();
		const betweenStore = {
			listAgentV2InputReferences: vi.fn(() => {
				between.abort();
				return [ref];
			}),
			readAgentV2InputBlob: vi.fn(),
		};
		await expect(
			new DurableAgentV2InputMaterializer(betweenStore).materialize({ run: runWith([ref]), signal: between.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(betweenStore.readAgentV2InputBlob).not.toHaveBeenCalled();

		const during = new AbortController();
		let settleBlob!: (value: AgentV2InputBlobRecord) => void;
		const duringStore = {
			listAgentV2InputReferences: vi.fn(() => [ref]),
			readAgentV2InputBlob: vi.fn(
				() =>
					new Promise<AgentV2InputBlobRecord>((resolve) => {
						settleBlob = resolve;
					}),
			),
		};
		const pending = new DurableAgentV2InputMaterializer(duringStore).materialize({
			run: runWith([ref]),
			signal: during.signal,
		});
		await vi.waitFor(() => expect(duringStore.readAgentV2InputBlob).toHaveBeenCalledTimes(1));
		during.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		settleBlob(blob(ref, content, "utf8"));
	});

	it("does not confuse a hostile abort lookalike with the private abort error", async () => {
		const lookalike = Object.create(null, {
			name: {
				get: () => {
					throw new Error("must-not-read");
				},
			},
		});
		const store = {
			listAgentV2InputReferences: vi.fn(() => Promise.reject(lookalike)),
			readAgentV2InputBlob: vi.fn(),
		};
		await expect(
			new DurableAgentV2InputMaterializer(store).materialize({
				run: runWith([]),
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "store_failure" });
	});

	it("cannot lose an abort fired synchronously by a store that returns pending work", async () => {
		const controller = new AbortController();
		const never = new Promise<AgentV2InputReferenceRecord[]>(() => undefined);
		const store = {
			listAgentV2InputReferences: vi.fn(() => {
				controller.abort();
				return never;
			}),
			readAgentV2InputBlob: vi.fn(),
		};
		const result = new DurableAgentV2InputMaterializer(store).materialize({
			run: runWith([]),
			signal: controller.signal,
		});
		await expect(Promise.race([result, timeoutAfter(100)])).rejects.toMatchObject({ name: "AbortError" });

		const content = bytes("pending blob");
		const ref = reference("project_file", 0, "pending-blob", "pending.txt", content);
		const blobController = new AbortController();
		const blobStore = {
			listAgentV2InputReferences: vi.fn(() => [ref]),
			readAgentV2InputBlob: vi.fn(() => {
				blobController.abort();
				return new Promise<AgentV2InputBlobRecord>(() => undefined);
			}),
		};
		const blobResult = new DurableAgentV2InputMaterializer(blobStore).materialize({
			run: runWith([ref]),
			signal: blobController.signal,
		});
		await expect(Promise.race([blobResult, timeoutAfter(100)])).rejects.toMatchObject({ name: "AbortError" });
	});

	it("observes a store promise that rejects after abort without an unhandled rejection", async () => {
		const controller = new AbortController();
		let rejectLate!: (reason: unknown) => void;
		const pending = new Promise<AgentV2InputReferenceRecord[]>((_resolve, reject) => {
			rejectLate = reject;
		});
		const store = {
			listAgentV2InputReferences: vi.fn(() => pending),
			readAgentV2InputBlob: vi.fn(),
		};
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = new DurableAgentV2InputMaterializer(store).materialize({
				run: runWith([]),
				signal: controller.signal,
			});
			await vi.waitFor(() => expect(store.listAgentV2InputReferences).toHaveBeenCalledTimes(1));
			controller.abort();
			await expect(result).rejects.toMatchObject({ name: "AbortError" });
			rejectLate(new Error("RAW_LATE_STORE_SECRET"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("uses AbortSignal/EventTarget intrinsics and sanitizes invalid signal proxies", async () => {
		const controller = new AbortController();
		const abortedGetter = vi.fn(() => {
			throw new Error("RAW_SIGNAL_ABORTED_SECRET");
		});
		const add = vi.fn(() => {
			throw new Error("RAW_SIGNAL_ADD_SECRET");
		});
		const remove = vi.fn(() => {
			throw new Error("RAW_SIGNAL_REMOVE_SECRET");
		});
		Object.defineProperties(controller.signal, {
			aborted: { configurable: true, get: abortedGetter },
			addEventListener: { configurable: true, value: add },
			removeEventListener: { configurable: true, value: remove },
		});
		await expect(
			new DurableAgentV2InputMaterializer(fakeStore([], new Map())).materialize({
				run: runWith([]),
				signal: controller.signal,
			}),
		).resolves.toEqual([]);
		expect(abortedGetter).not.toHaveBeenCalled();
		expect(add).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();

		let failure: unknown;
		try {
			await new DurableAgentV2InputMaterializer(fakeStore([], new Map())).materialize({
				run: runWith([]),
				signal: new Proxy(new AbortController().signal, {
					get: () => {
						throw new Error("RAW_SIGNAL_PROXY_SECRET");
					},
				}),
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({ code: "store_failure" });
		expect(`${String(failure)}\n${failure instanceof Error ? failure.stack : ""}`).not.toContain(
			"RAW_SIGNAL_PROXY_SECRET",
		);
	});

	it("rebuilds public materialization errors and hostile thenables as constant store failures", async () => {
		const sentinel = "RAW_FORGED_MATERIALIZATION_SECRET";
		const forged = new AgentV2InputMaterializationError("authorization_mismatch");
		Object.defineProperties(forged, {
			message: { configurable: true, get: () => sentinel },
			stack: { configurable: true, get: () => `${sentinel}_STACK` },
			code: { configurable: true, enumerable: true, get: () => `${sentinel}_CODE` },
		});
		class ForgedSubclass extends AgentV2InputMaterializationError {}
		const subclass = new ForgedSubclass("missing_blob");
		Object.defineProperty(subclass, "message", { configurable: true, value: sentinel });
		const arbitraryCode = new AgentV2InputMaterializationError(`${sentinel}_RUNTIME_CODE` as never);
		const failures: Array<() => unknown> = [
			() => {
				throw forged;
			},
			() => Promise.reject(forged),
			() => Promise.reject(subclass),
			() => Promise.reject(arbitraryCode),
			() => Promise.reject(new Proxy(forged, {})),
			() => ({
				// biome-ignore lint/suspicious/noThenProperty: hostile thenable assimilation is the security boundary under test.
				then: (_resolve: unknown, reject: (reason: unknown) => void) => reject(forged),
			}),
		];
		for (const listAgentV2InputReferences of failures) {
			let failure: unknown;
			try {
				await new DurableAgentV2InputMaterializer({
					listAgentV2InputReferences,
					readAgentV2InputBlob: vi.fn(),
				} as MaterializerStore).materialize({ run: runWith([]), signal: new AbortController().signal });
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({ code: "store_failure" });
			expect(
				`${String(failure)}\n${failure instanceof Error ? failure.stack : ""}\n${JSON.stringify(failure)}`,
			).not.toContain(sentinel);
		}
	});

	it("does not let public materialization errors forge validator taxonomy or leak runtime codes", async () => {
		const sentinel = "RAW_FORGED_VALIDATOR_SECRET";
		const publicError = new AgentV2InputMaterializationError("missing_blob");
		Object.defineProperties(publicError, {
			message: { configurable: true, value: sentinel },
			stack: { configurable: true, value: `${sentinel}_STACK` },
		});
		class ForgedValidatorSubclass extends AgentV2InputMaterializationError {}
		const subclass = new ForgedValidatorSubclass("limit_exceeded");
		Object.defineProperty(subclass, "message", { configurable: true, value: sentinel });
		const runtimeCode = `${sentinel}_CODE`;
		const arbitrary = new AgentV2InputMaterializationError(runtimeCode as never);

		const hostileRun = new Proxy(runWith([]), {
			getPrototypeOf: () => {
				throw arbitrary;
			},
		});
		const content = bytes("authorized");
		const ref = reference("project_file", 0, "validator", "validator.txt", content);
		const hostileReference = new Proxy(ref, {
			getPrototypeOf: () => {
				throw subclass;
			},
		});
		const hostileBlob = new Proxy(blob(ref, content, "utf8"), {
			getPrototypeOf: () => {
				throw publicError;
			},
		});
		const probes: Array<[() => Promise<unknown>, string]> = [
			[
				() =>
					new DurableAgentV2InputMaterializer(fakeStore([], new Map())).materialize({
						run: hostileRun,
						signal: new AbortController().signal,
					}),
				"authorization_mismatch",
			],
			[
				() =>
					materialize(fakeStore([hostileReference], new Map([[ref.inputId, blob(ref, content, "utf8")]])), [ref]),
				"authorization_mismatch",
			],
			[() => materialize(fakeStore([ref], new Map([[ref.inputId, hostileBlob]])), [ref]), "store_failure"],
		];

		for (const [probe, expectedCode] of probes) {
			let failure: unknown;
			try {
				await probe();
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({ code: expectedCode });
			expect(
				`${String(failure)}\n${failure instanceof Error ? failure.stack : ""}\n${JSON.stringify(failure)}`,
			).not.toContain(sentinel);
		}
	});
});

type MaterializerStore = ConstructorParameters<typeof DurableAgentV2InputMaterializer>[0];

function fakeStore(references: readonly AgentV2InputReferenceRecord[], blobs: Map<string, AgentV2InputBlobRecord>) {
	return {
		listAgentV2InputReferences: vi.fn(() => references.slice()),
		readAgentV2InputBlob: vi.fn((_clientId: string, _runId: string, inputId: string) => blobs.get(inputId)),
	};
}

async function materialize(
	store: MaterializerStore,
	references: readonly AgentV2InputReferenceRecord[],
	runInput: Record<string, unknown> = { objective: "Build", inputReferences: references },
) {
	return await new DurableAgentV2InputMaterializer(store).materialize({
		run: runWith(references, runInput),
		signal: new AbortController().signal,
	});
}

function runWith(
	references: readonly AgentV2InputReferenceRecord[],
	input: Record<string, unknown> = { objective: "Build", inputReferences: references },
): AgentV2RunSnapshot {
	return {
		clientId: CLIENT_ID,
		runId: RUN_ID,
		status: "running",
		phase: "implementation",
		attempt: 1,
		input,
		model: { provider: "test", id: "model" },
		workerId: "worker",
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
	};
}

function reference(
	kind: AgentV2InputReferenceRecord["kind"],
	ordinal: number,
	inputId: string,
	logicalPath: string,
	content: Uint8Array,
	displayName?: string,
	mediaType = logicalPath.endsWith(".png") ? "image/png" : "text/plain",
): AgentV2InputReferenceRecord {
	return {
		clientId: CLIENT_ID,
		runId: RUN_ID,
		kind,
		ordinal,
		inputId,
		logicalPath,
		...(displayName === undefined ? {} : { displayName }),
		mediaType,
		byteLength: content.byteLength,
		checksum: checksum(content),
	};
}

function blob(
	referenceValue: AgentV2InputReferenceRecord,
	content: Uint8Array,
	encoding: AgentV2InputBlobRecord["encoding"],
): AgentV2InputBlobRecord {
	return {
		clientId: referenceValue.clientId,
		runId: referenceValue.runId,
		inputId: referenceValue.inputId,
		logicalPath: referenceValue.logicalPath,
		mediaType: referenceValue.mediaType,
		encoding,
		bytes: content,
		byteLength: content.byteLength,
		checksum: checksum(content),
		createdAt: CREATED_AT,
	};
}

function checksum(content: Uint8Array): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function pngBytes(): Uint8Array {
	return new Uint8Array(
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		),
	);
}

function sizedPng(byteLength: number, marker: number): Uint8Array {
	const base = pngBytes();
	const fillerLength = byteLength - base.byteLength - 12;
	if (fillerLength < 1) throw new Error("sizedPng target is too small");
	const result = new Uint8Array(byteLength);
	const beforeIend = base.subarray(0, base.byteLength - 12);
	result.set(beforeIend, 0);
	const chunkOffset = beforeIend.byteLength;
	writeU32Be(result, chunkOffset, fillerLength);
	result.set([0x72, 0x75, 0x53, 0x74], chunkOffset + 4);
	result[chunkOffset + 8] = marker;
	writeU32Be(result, chunkOffset + 8 + fillerLength, crc32(result, chunkOffset + 4, chunkOffset + 8 + fillerLength));
	result.set(base.subarray(base.byteLength - 12), chunkOffset + 12 + fillerLength);
	return result;
}

function jpegBytes(): Uint8Array {
	return decodedFixture([
		"/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABh",
		"Y3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAAB",
		"UAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAA",
		"AAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9Y",
		"WVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAM",
		"ZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYI",
		"DAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQU",
		"FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/",
		"xAAbEAABBQEBAAAAAAAAAAAAAAABAgMEBQcABv/EABUBAQEAAAAAAAAAAAAAAAAAAAUI/8QAGxEAAAcBAAAAAAAAAAAAAAAAAAED",
		"BDRysQL/2gAMAwEAAhEDEQA/AJ93retM8duei0FBovrKOiqvR2MGvrK28kx40OO1JcQ0y00hYS22hCUpSlIAAAAAA5znU2wiI15w",
		"ge9lK2PR/9k=",
	]);
}

function progressiveJpegBytes(): Uint8Array {
	return decodedFixture([
		"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMU",
		"FRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU",
		"FBQUFBQUFBT/wgARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUAQEAAAAAAAAAAAAAAAAAAAAG/9oA",
		"DAMBAAIQAxAAAAG6gcA//8QAFhABAQEAAAAAAAAAAAAAAAAABAYD/9oACAEBAAEFApsBtJ7/xAAZEQABBQAAAAAAAAAAAAAAAAAA",
		"AQIEM3H/2gAIAQMBAT8Bk3v1T//EABkRAAEFAAAAAAAAAAAAAAAAAAABAgMzcf/aAAgBAgEBPwGe1+qf/8QAGxAAAgIDAQAAAAAA",
		"AAAAAAAAAQIDBAAFESL/2gAIAQEABj8C1bNXiZmqxEkoOnyM/8QAFhABAQEAAAAAAAAAAAAAAAAAAREA/9oACAEBAAE/IUb8PI2V",
		"m//aAAwDAQACAAMAAAAQ9//EABcRAAMBAAAAAAAAAAAAAAAAAAABUfD/2gAIAQMBAT8Q1qz/xAAXEQADAQAAAAAAAAAAAAAAAAAA",
		"AVHw/9oACAECAQE/ENis/8QAFxABAQEBAAAAAAAAAAAAAAAAAREAMf/aAAgBAQABPxBLxVstClVVXt3/2Q==",
	]);
}

function jpegScanMarkerExerciseBytes(): Uint8Array {
	const frame = new Uint8Array([0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00]);
	const dcScan = new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x12, 0xff]);
	const acScan = new Uint8Array([
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x3f, 0x00, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78,
	]);
	return concatBytes(new Uint8Array([0xff, 0xd8]), frame, dcScan, acScan, new Uint8Array([0xff, 0xd9]));
}

function jpegWithoutSos(): Uint8Array {
	return new Uint8Array([
		0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03,
		0x11, 0x00, 0xff, 0xd9,
	]);
}

function jpegWithEmptyScan(): Uint8Array {
	return concatBytes(
		jpegWithoutSos().subarray(0, jpegWithoutSos().byteLength - 2),
		new Uint8Array([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]),
		new Uint8Array([0xff, 0xd9]),
	);
}

function jpegWithRestartOnlyScan(): Uint8Array {
	const empty = jpegWithEmptyScan();
	return concatBytes(empty.subarray(0, empty.byteLength - 2), new Uint8Array([0xff, 0xd0, 0xff, 0xd9]));
}

function jpegWithRestartOutsideScan(): Uint8Array {
	const base = jpegBytes();
	return concatBytes(base.subarray(0, 2), new Uint8Array([0xff, 0xd0]), base.subarray(2));
}

function jpegWithMarkerInsideScan(): Uint8Array {
	const empty = jpegWithEmptyScan();
	return concatBytes(empty.subarray(0, empty.byteLength - 2), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
}

function jpegWithTruncatedScanHeader(): Uint8Array {
	return concatBytes(
		jpegWithoutSos().subarray(0, jpegWithoutSos().byteLength - 2),
		new Uint8Array([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0xff, 0xd9]),
	);
}

function realVp8Payload(): Uint8Array {
	return new Uint8Array(
		Buffer.from(
			"3002009d012a0200020000c01225a00274ba01f800032106fb8000feff8cf353ce37ef80d5ffe32a7c485f890bff1953ff5067c833e419f9c6000000",
			"hex",
		),
	);
}

function realVp8lPayload(): Uint8Array {
	return new Uint8Array(Buffer.from("2f014000001730fff3bffff31f2c850b2444f43f0200", "hex"));
}

function vp8WebpBytes(): Uint8Array {
	return simpleWebp("VP8 ", realVp8Payload());
}

function webpBytes(): Uint8Array {
	return simpleWebp("VP8L", realVp8lPayload());
}

function extendedWebpBytes(flags = 0): Uint8Array {
	return webpContainer(flags, [webpChunk("VP8L", realVp8lPayload())]);
}

function encodedVp8xAlphaWebpBytes(): Uint8Array {
	return webpContainer(0x10, [
		webpChunk("ALPH", new Uint8Array([0x00, 0x7f, 0x00, 0x00, 0xbf])),
		webpChunk("VP8 ", realVp8Payload()),
	]);
}

function animatedWebpBytes(flags = 0x02): Uint8Array {
	return webpContainer(flags, [webpChunk("ANIM", new Uint8Array(6)), animationFrameChunk()]);
}

function duplicatePrimaryWebpBytes(): Uint8Array {
	const primary = webpChunk("VP8L", realVp8lPayload());
	return webpContainer(0, [primary, primary]);
}

function misorderedAnimatedWebpBytes(): Uint8Array {
	return webpContainer(0x02, [animationFrameChunk(), webpChunk("ANIM", new Uint8Array(6))]);
}

function animationFrameChunk(): Uint8Array {
	const frameHeader = new Uint8Array(16);
	writeU24Le(frameHeader, 6, 1);
	writeU24Le(frameHeader, 9, 1);
	return webpChunk("ANMF", concatBytes(frameHeader, webpChunk("VP8L", realVp8lPayload())));
}

function simpleWebp(type: "VP8 " | "VP8L", payload: Uint8Array): Uint8Array {
	const body = webpChunk(type, payload);
	const result = new Uint8Array(12 + body.byteLength);
	result.set([0x52, 0x49, 0x46, 0x46], 0);
	writeU32Le(result, 4, result.byteLength - 8);
	result.set([0x57, 0x45, 0x42, 0x50], 8);
	result.set(body, 12);
	return result;
}

function headerOnlyVp8WebpBytes(): Uint8Array {
	return simpleWebp("VP8 ", realVp8Payload().subarray(0, 10));
}

function invalidVp8FrameWebpBytes(kind: "hidden" | "inter" | "partition"): Uint8Array {
	const payload = new Uint8Array(realVp8Payload());
	if (kind === "hidden") payload[0] &= ~0x10;
	if (kind === "inter") payload[0] |= 0x01;
	if (kind === "partition") payload.set([0x10, 0xff, 0xff], 0);
	return simpleWebp("VP8 ", payload);
}

function headerOnlyVp8lWebpBytes(): Uint8Array {
	return simpleWebp("VP8L", realVp8lPayload().subarray(0, 5));
}

function extendedHeaderOnlyWebpBytes(): Uint8Array {
	return webpContainer(0, [webpChunk("VP8L", realVp8lPayload().subarray(0, 5))]);
}

function animatedHeaderOnlyWebpBytes(): Uint8Array {
	const frameHeader = new Uint8Array(16);
	writeU24Le(frameHeader, 6, 1);
	writeU24Le(frameHeader, 9, 1);
	const frame = webpChunk("ANMF", concatBytes(frameHeader, webpChunk("VP8L", realVp8lPayload().subarray(0, 5))));
	return webpContainer(0x02, [webpChunk("ANIM", new Uint8Array(6)), frame]);
}

function shortRawAlphaWebpBytes(): Uint8Array {
	return webpContainer(0x10, [webpChunk("ALPH", new Uint8Array([0x00, 0x7f])), webpChunk("VP8 ", realVp8Payload())]);
}

function invalidAlphaWebpBytes(header: number, payloadLength: number): Uint8Array {
	const alpha = new Uint8Array(1 + payloadLength);
	alpha[0] = header;
	return webpContainer(0x10, [webpChunk("ALPH", alpha), webpChunk("VP8 ", realVp8Payload())]);
}

function vp8xOnlyWebpBytes(): Uint8Array {
	return webpContainer(0, []);
}

function webpWithNonzeroPadding(): Uint8Array {
	const result = simpleWebp("VP8L", concatBytes(realVp8lPayload(), new Uint8Array([0])));
	result[result.byteLength - 1] = 0xff;
	return result;
}

function webpContainer(flags: number, chunks: readonly Uint8Array[]): Uint8Array {
	const vp8x = new Uint8Array(10);
	vp8x[0] = flags;
	writeU24Le(vp8x, 4, 1);
	writeU24Le(vp8x, 7, 1);
	const body = concatBytes(webpChunk("VP8X", vp8x), ...chunks);
	const result = new Uint8Array(12 + body.byteLength);
	result.set([0x52, 0x49, 0x46, 0x46], 0);
	writeU32Le(result, 4, result.byteLength - 8);
	result.set([0x57, 0x45, 0x42, 0x50], 8);
	result.set(body, 12);
	return result;
}

function decodedFixture(parts: readonly string[]): Uint8Array {
	return new Uint8Array(Buffer.from(parts.join(""), "base64"));
}

function webpChunk(type: string, data: Uint8Array): Uint8Array {
	const result = new Uint8Array(8 + data.byteLength + (data.byteLength & 1));
	for (let index = 0; index < 4; index += 1) result[index] = type.charCodeAt(index);
	writeU32Le(result, 4, data.byteLength);
	result.set(data, 8);
	return result;
}

function pngWithoutIdat(): Uint8Array {
	const base = pngBytes();
	return concatBytes(base.subarray(0, 33), base.subarray(base.byteLength - 12));
}

function pngWithEmptyIdat(): Uint8Array {
	const base = pngBytes();
	return concatBytes(base.subarray(0, 33), pngChunk("IDAT", new Uint8Array()), base.subarray(base.byteLength - 12));
}

function pngWithNonContiguousIdat(): Uint8Array {
	const base = pngBytes();
	return concatBytes(
		base.subarray(0, 33),
		pngChunk("IDAT", new Uint8Array([1])),
		pngChunk("tEXt", new Uint8Array([2])),
		pngChunk("IDAT", new Uint8Array([3])),
		base.subarray(base.byteLength - 12),
	);
}

function pngWithChunkAfterIhdr(type: string, data: Uint8Array): Uint8Array {
	const base = pngBytes();
	return concatBytes(base.subarray(0, 33), pngChunk(type, data), base.subarray(33));
}

function pngWithPlteAfterIdat(): Uint8Array {
	const base = pngBytes();
	return concatBytes(
		base.subarray(0, base.byteLength - 12),
		pngChunk("PLTE", new Uint8Array([0, 0, 0])),
		base.subarray(base.byteLength - 12),
	);
}

function pngWithDuplicatePlte(): Uint8Array {
	const base = pngBytes();
	const palette = pngChunk("PLTE", new Uint8Array([0, 0, 0]));
	return concatBytes(base.subarray(0, 33), palette, palette, base.subarray(33));
}

function grayscalePngWithPlte(): Uint8Array {
	return pngWithChunkAfterIhdrFrom(mutatePngHeader(pngBytes(), 8, 0), "PLTE", new Uint8Array([0, 0, 0]));
}

function indexedPngWithoutPlte(): Uint8Array {
	return mutatePngHeader(pngBytes(), 8, 3);
}

function indexedPngWithOversizedPlte(): Uint8Array {
	return pngWithChunkAfterIhdrFrom(
		mutatePngHeader(pngBytes(), 1, 3),
		"PLTE",
		new Uint8Array([0, 0, 0, 0xff, 0xff, 0xff, 0x7f, 0x7f, 0x7f]),
	);
}

function indexedPngWithValidPlte(): Uint8Array {
	return pngWithChunkAfterIhdrFrom(
		mutatePngHeader(pngBytes(), 1, 3),
		"PLTE",
		new Uint8Array([0, 0, 0, 0xff, 0xff, 0xff]),
	);
}

function pngWithChunkAfterIhdrFrom(base: Uint8Array, type: string, data: Uint8Array): Uint8Array {
	return concatBytes(base.subarray(0, 33), pngChunk(type, data), base.subarray(33));
}

function mutatePngHeader(content: Uint8Array, bitDepth: number, colorType: number): Uint8Array {
	const result = new Uint8Array(content);
	result[24] = bitDepth;
	result[25] = colorType;
	writeU32Be(result, 29, crc32(result, 12, 29));
	return result;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const result = new Uint8Array(12 + data.byteLength);
	writeU32Be(result, 0, data.byteLength);
	for (let index = 0; index < 4; index += 1) result[index + 4] = type.charCodeAt(index);
	result.set(data, 8);
	writeU32Be(result, 8 + data.byteLength, crc32(result, 4, 8 + data.byteLength));
	return result;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function mutatePngWidth(content: Uint8Array, width: number): Uint8Array {
	const result = new Uint8Array(content);
	writeU32Be(result, 16, width);
	writeU32Be(result, 29, crc32(result, 12, 29));
	return result;
}

function mutateWebpRiffSize(content: Uint8Array, size: number): Uint8Array {
	const result = new Uint8Array(content);
	result[4] = size & 0xff;
	result[5] = (size >>> 8) & 0xff;
	result[6] = (size >>> 16) & 0xff;
	result[7] = (size >>> 24) & 0xff;
	return result;
}

function writeU32Be(target: Uint8Array, offset: number, value: number): void {
	target[offset] = (value >>> 24) & 0xff;
	target[offset + 1] = (value >>> 16) & 0xff;
	target[offset + 2] = (value >>> 8) & 0xff;
	target[offset + 3] = value & 0xff;
}

function writeU32Le(target: Uint8Array, offset: number, value: number): void {
	target[offset] = value & 0xff;
	target[offset + 1] = (value >>> 8) & 0xff;
	target[offset + 2] = (value >>> 16) & 0xff;
	target[offset + 3] = (value >>> 24) & 0xff;
}

function writeU24Le(target: Uint8Array, offset: number, value: number): void {
	target[offset] = value & 0xff;
	target[offset + 1] = (value >>> 8) & 0xff;
	target[offset + 2] = (value >>> 16) & 0xff;
}

function crc32(bytesValue: Uint8Array, start: number, end: number): number {
	let crc = 0xffff_ffff;
	for (let index = start; index < end; index += 1) {
		crc ^= bytesValue[index] ?? 0;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
	}
	return (crc ^ 0xffff_ffff) >>> 0;
}

function timeoutAfter(milliseconds: number): Promise<never> {
	return new Promise((_resolve, reject) => {
		setTimeout(() => reject(new Error("TIMED_OUT")), milliseconds);
	});
}
