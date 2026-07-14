import { createHash } from "node:crypto";
import { AGENT_V2_INPUT_LIMITS } from "./agent-v2-start-input.js";
const MATERIALIZATION_ERROR_CODES = new WeakMap();
const ABORT_ERRORS = new WeakSet();
const ERROR_MESSAGES = Object.freeze({
    authorization_mismatch: "Agent v2 committed input authorization does not match durable input references.",
    missing_blob: "Agent v2 committed input blob is missing.",
    corrupt_blob: "Agent v2 committed input blob metadata is invalid.",
    integrity_mismatch: "Agent v2 committed input blob failed integrity verification.",
    unsupported_media: "Agent v2 committed input media or encoding is unsupported.",
    limit_exceeded: "Agent v2 committed input exceeds the materialization limits.",
    store_failure: "Agent v2 committed input store operation failed.",
});
export class AgentV2InputMaterializationError extends Error {
    code;
    constructor(code) {
        super(ERROR_MESSAGES[code]);
        this.name = "AgentV2InputMaterializationError";
        this.code = code;
    }
}
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = requireGetter(TYPED_ARRAY_PROTOTYPE, "byteLength");
const TYPED_ARRAY_BYTE_OFFSET_GETTER = requireGetter(TYPED_ARRAY_PROTOTYPE, "byteOffset");
const TYPED_ARRAY_BUFFER_GETTER = requireGetter(TYPED_ARRAY_PROTOTYPE, "buffer");
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = requireGetter(ArrayBuffer.prototype, "byteLength");
const ABORT_SIGNAL_ABORTED_GETTER = requireGetter(AbortSignal.prototype, "aborted");
const EVENT_TARGET_ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const EVENT_TARGET_REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;
const REFERENCE_FIELDS = new Set([
    "clientId",
    "runId",
    "kind",
    "ordinal",
    "inputId",
    "logicalPath",
    "displayName",
    "mediaType",
    "byteLength",
    "checksum",
]);
const BLOB_FIELDS = new Set([
    "clientId",
    "runId",
    "inputId",
    "logicalPath",
    "mediaType",
    "encoding",
    "bytes",
    "byteLength",
    "checksum",
    "createdAt",
]);
const MAX_ID_CODE_UNITS = 512;
const MAX_PATH_CODE_UNITS = 4_096;
const MAX_DISPLAY_NAME_CODE_UNITS = 1_024;
class AgentV2InputAbortError extends Error {
    constructor() {
        super("Agent v2 input materialization was aborted.");
        this.name = "AbortError";
        ABORT_ERRORS.add(this);
    }
}
export class DurableAgentV2InputMaterializer {
    store;
    constructor(store) {
        this.store = store;
    }
    async materialize(input) {
        throwIfAborted(input.signal);
        const run = sanitizeRun(input.run);
        const durableValue = await settleStoreCall(() => this.store.listAgentV2InputReferences(run.clientId, run.runId), input.signal);
        throwIfAborted(input.signal);
        const durableReferences = sanitizeReferenceArray(durableValue, "authorization_mismatch");
        const authorized = reconcileReferences(run.references, durableReferences, run.clientId, run.runId);
        if (authorized.length > AGENT_V2_INPUT_LIMITS.maxEntries)
            fail("limit_exceeded");
        const result = [];
        let totalBytes = 0;
        for (const reference of authorized) {
            throwIfAborted(input.signal);
            const blobValue = await settleStoreCall(() => this.store.readAgentV2InputBlob(run.clientId, run.runId, reference.inputId), input.signal);
            throwIfAborted(input.signal);
            if (blobValue === undefined)
                fail("missing_blob");
            const verified = verifyBlob(blobValue, reference, run.clientId, run.runId, run.createdAt);
            totalBytes += verified.bytes.byteLength;
            if (!Number.isSafeInteger(totalBytes) || totalBytes > AGENT_V2_INPUT_LIMITS.maxTotalBytes) {
                fail("limit_exceeded");
            }
            const outputReference = authorizedReference(reference);
            if (verified.encoding === "utf8") {
                result.push({
                    kind: "text",
                    reference: outputReference,
                    text: verified.text ?? "",
                    checksum: verified.checksum,
                });
                continue;
            }
            if (reference.kind !== "attachment")
                fail("unsupported_media");
            result.push({
                kind: "image",
                reference: outputReference,
                data: new Uint8Array(verified.bytes),
                mediaType: verified.mediaType,
                checksum: verified.checksum,
            });
        }
        return result;
    }
}
function sanitizeRun(value) {
    try {
        const run = plainRecord(value, "authorization_mismatch");
        const clientId = boundedString(dataValue(run, "clientId", "authorization_mismatch"), MAX_ID_CODE_UNITS);
        const runId = boundedString(dataValue(run, "runId", "authorization_mismatch"), MAX_ID_CODE_UNITS);
        const createdAt = canonicalTimestamp(dataValue(run, "createdAt", "authorization_mismatch"), "authorization_mismatch");
        const runInput = plainRecord(dataValue(run, "input", "authorization_mismatch"), "authorization_mismatch");
        const references = sanitizeReferenceArray(dataValue(runInput, "inputReferences", "authorization_mismatch"), "authorization_mismatch");
        return { clientId, runId, createdAt, references };
    }
    catch (error) {
        rethrowKnownOrFail(error, "authorization_mismatch");
    }
}
function sanitizeReferenceArray(value, code) {
    try {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
            fail(code);
        const length = value.length;
        if (!Number.isSafeInteger(length) || length < 0 || length > AGENT_V2_INPUT_LIMITS.maxEntries) {
            fail("limit_exceeded");
        }
        const references = [];
        for (let index = 0; index < length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!isDataDescriptor(descriptor))
                fail(code);
            references.push(sanitizeReference(descriptor.value, code));
        }
        return references;
    }
    catch (error) {
        rethrowKnownOrFail(error, code);
    }
}
function sanitizeReference(value, code) {
    const record = plainRecord(value, code);
    assertOnlyFields(record, REFERENCE_FIELDS, code);
    const kind = dataValue(record, "kind", code);
    if (kind !== "attachment" && kind !== "project_file")
        fail(code);
    const ordinal = dataValue(record, "ordinal", code);
    if (!Number.isSafeInteger(ordinal) ||
        ordinal < 0 ||
        ordinal >= AGENT_V2_INPUT_LIMITS.maxEntries) {
        fail(code);
    }
    const byteLength = dataValue(record, "byteLength", code);
    if (!Number.isSafeInteger(byteLength) ||
        byteLength < 0 ||
        byteLength > AGENT_V2_INPUT_LIMITS.maxImageBytes) {
        fail("limit_exceeded");
    }
    const hasDisplayName = Object.hasOwn(record, "displayName");
    const displayName = hasDisplayName
        ? boundedString(dataValue(record, "displayName", code), MAX_DISPLAY_NAME_CODE_UNITS, code)
        : undefined;
    if ((kind === "attachment") !== hasDisplayName)
        fail(code);
    const checksum = boundedString(dataValue(record, "checksum", code), 71, code);
    if (!/^sha256:[0-9a-f]{64}$/u.test(checksum))
        fail(code);
    return {
        clientId: boundedString(dataValue(record, "clientId", code), MAX_ID_CODE_UNITS, code),
        runId: boundedString(dataValue(record, "runId", code), MAX_ID_CODE_UNITS, code),
        kind,
        ordinal: ordinal,
        inputId: boundedString(dataValue(record, "inputId", code), MAX_ID_CODE_UNITS, code),
        logicalPath: boundedString(dataValue(record, "logicalPath", code), MAX_PATH_CODE_UNITS, code),
        ...(displayName === undefined ? {} : { displayName }),
        mediaType: boundedString(dataValue(record, "mediaType", code), 128, code),
        byteLength: byteLength,
        checksum,
    };
}
function reconcileReferences(committed, durable, clientId, runId) {
    if (committed.length !== durable.length)
        fail("authorization_mismatch");
    const committedByKey = indexReferences(committed, clientId, runId);
    const durableByKey = indexReferences(durable, clientId, runId);
    if (committedByKey.size !== durableByKey.size)
        fail("authorization_mismatch");
    for (const [key, reference] of committedByKey) {
        const stored = durableByKey.get(key);
        if (!stored || !sameReference(reference, stored))
            fail("authorization_mismatch");
    }
    const ordered = [...committedByKey.values()].sort(compareReferenceSemantics);
    const selected = new Map();
    for (const reference of ordered) {
        const previous = selected.get(reference.inputId);
        if (!previous) {
            selected.set(reference.inputId, reference);
            continue;
        }
        if (!sameContentIdentity(previous, reference))
            fail("authorization_mismatch");
        if (previous.kind === "project_file" && reference.kind === "attachment") {
            selected.set(reference.inputId, reference);
        }
    }
    return [...selected.values()].sort(compareReferenceSemantics);
}
function indexReferences(references, clientId, runId) {
    const result = new Map();
    for (const reference of references) {
        if (reference.clientId !== clientId || reference.runId !== runId)
            fail("authorization_mismatch");
        const key = `${reference.kind}:${reference.ordinal}`;
        if (result.has(key))
            fail("authorization_mismatch");
        result.set(key, reference);
    }
    return result;
}
function verifyBlob(value, reference, clientId, runId, runCreatedAt) {
    try {
        const record = plainRecord(value, "corrupt_blob");
        assertOnlyFields(record, BLOB_FIELDS, "corrupt_blob");
        const identity = {
            clientId: boundedString(dataValue(record, "clientId", "corrupt_blob"), MAX_ID_CODE_UNITS, "corrupt_blob"),
            runId: boundedString(dataValue(record, "runId", "corrupt_blob"), MAX_ID_CODE_UNITS, "corrupt_blob"),
            inputId: boundedString(dataValue(record, "inputId", "corrupt_blob"), MAX_ID_CODE_UNITS, "corrupt_blob"),
            logicalPath: boundedString(dataValue(record, "logicalPath", "corrupt_blob"), MAX_PATH_CODE_UNITS, "corrupt_blob"),
            mediaType: boundedString(dataValue(record, "mediaType", "corrupt_blob"), 128, "corrupt_blob"),
            checksum: boundedString(dataValue(record, "checksum", "corrupt_blob"), 71, "corrupt_blob"),
        };
        if (identity.clientId !== clientId || identity.runId !== runId || identity.inputId !== reference.inputId) {
            fail("corrupt_blob");
        }
        const encoding = dataValue(record, "encoding", "corrupt_blob");
        if (encoding !== "utf8" && encoding !== "binary")
            fail("unsupported_media");
        const byteLength = dataValue(record, "byteLength", "corrupt_blob");
        if (!Number.isSafeInteger(byteLength) ||
            byteLength < 0 ||
            byteLength > AGENT_V2_INPUT_LIMITS.maxImageBytes) {
            fail("limit_exceeded");
        }
        const createdAt = canonicalTimestamp(dataValue(record, "createdAt", "corrupt_blob"), "corrupt_blob");
        if (createdAt !== runCreatedAt)
            fail("corrupt_blob");
        const bytes = copyBoundedBytes(dataValue(record, "bytes", "corrupt_blob"));
        const recomputedChecksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (identity.logicalPath !== reference.logicalPath ||
            identity.mediaType !== reference.mediaType ||
            byteLength !== reference.byteLength ||
            bytes.byteLength !== byteLength ||
            identity.checksum !== reference.checksum ||
            recomputedChecksum !== identity.checksum) {
            fail("integrity_mismatch");
        }
        const media = sniffAndDecode(bytes);
        if (identity.mediaType !== media.mediaType || encoding !== media.encoding)
            fail("unsupported_media");
        const perFileLimit = media.encoding === "utf8" ? AGENT_V2_INPUT_LIMITS.maxTextBytes : AGENT_V2_INPUT_LIMITS.maxImageBytes;
        if (bytes.byteLength > perFileLimit)
            fail("limit_exceeded");
        return { ...media, bytes, checksum: recomputedChecksum };
    }
    catch (error) {
        rethrowKnownOrFail(error, "corrupt_blob");
    }
}
function sniffAndDecode(bytes) {
    if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        if (!isStructurallyValidPng(bytes))
            fail("unsupported_media");
        return { mediaType: "image/png", encoding: "binary" };
    }
    if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) {
        if (!isStructurallyValidJpeg(bytes))
            fail("unsupported_media");
        return { mediaType: "image/jpeg", encoding: "binary" };
    }
    if (bytes.byteLength >= 12 &&
        hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50) {
        if (!isStructurallyValidWebp(bytes))
            fail("unsupported_media");
        return { mediaType: "image/webp", encoding: "binary" };
    }
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
        fail("unsupported_media");
    }
    const roundTrip = new TextEncoder().encode(text);
    if (roundTrip.byteLength !== bytes.byteLength)
        fail("unsupported_media");
    for (let index = 0; index < bytes.byteLength; index += 1) {
        if (roundTrip[index] !== bytes[index])
            fail("unsupported_media");
    }
    return { mediaType: "text/plain", encoding: "utf8", text };
}
function isStructurallyValidPng(bytes) {
    if (bytes.byteLength < 45)
        return false;
    let offset = 8;
    let sawHeader = false;
    let sawIdat = false;
    let sawNonEmptyIdat = false;
    let idatSequenceClosed = false;
    let sawPalette = false;
    let bitDepth = 0;
    let colorType = -1;
    while (offset <= bytes.byteLength - 12) {
        const length = readU32Be(bytes, offset);
        if (length > bytes.byteLength - offset - 12)
            return false;
        const typeOffset = offset + 4;
        const dataOffset = offset + 8;
        const crcOffset = dataOffset + length;
        for (let index = 0; index < 4; index += 1) {
            const code = bytes[typeOffset + index] ?? 0;
            if (!((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)))
                return false;
        }
        if ((bytes[typeOffset + 2] ?? 0) >= 0x61)
            return false;
        if (crc32(bytes, typeOffset, crcOffset) !== readU32Be(bytes, crcOffset))
            return false;
        const isHeader = hasAsciiAt(bytes, typeOffset, "IHDR");
        const isPalette = hasAsciiAt(bytes, typeOffset, "PLTE");
        const isIdat = hasAsciiAt(bytes, typeOffset, "IDAT");
        const isEnd = hasAsciiAt(bytes, typeOffset, "IEND");
        if ((bytes[typeOffset] ?? 0) <= 0x5a && !isHeader && !isPalette && !isIdat && !isEnd)
            return false;
        if (!sawHeader) {
            if (!isHeader || length !== 13 || !validPngHeader(bytes, dataOffset))
                return false;
            sawHeader = true;
            bitDepth = bytes[dataOffset + 8] ?? 0;
            colorType = bytes[dataOffset + 9] ?? -1;
        }
        else if (isHeader) {
            return false;
        }
        else if (isPalette) {
            if (sawPalette ||
                sawIdat ||
                colorType === 0 ||
                colorType === 4 ||
                length === 0 ||
                length > 256 * 3 ||
                length % 3 !== 0 ||
                (colorType === 3 && length / 3 > 2 ** bitDepth)) {
                return false;
            }
            sawPalette = true;
        }
        else if (isIdat) {
            if (idatSequenceClosed)
                return false;
            sawIdat = true;
            if (length > 0)
                sawNonEmptyIdat = true;
        }
        else if (sawIdat && !isEnd) {
            idatSequenceClosed = true;
        }
        offset = crcOffset + 4;
        if (isEnd) {
            return length === 0 && sawNonEmptyIdat && (colorType !== 3 || sawPalette) && offset === bytes.byteLength;
        }
    }
    return false;
}
function validPngHeader(bytes, offset) {
    const width = readU32Be(bytes, offset);
    const height = readU32Be(bytes, offset + 4);
    if (width === 0 || height === 0 || width > 0x7fff_ffff || height > 0x7fff_ffff)
        return false;
    const bitDepth = bytes[offset + 8] ?? 0;
    const colorType = bytes[offset + 9] ?? 0;
    const allowedDepths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
    };
    return ((allowedDepths[colorType]?.includes(bitDepth) ?? false) &&
        bytes[offset + 10] === 0 &&
        bytes[offset + 11] === 0 &&
        (bytes[offset + 12] === 0 || bytes[offset + 12] === 1));
}
function isStructurallyValidJpeg(bytes) {
    if (bytes.byteLength < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
        return false;
    let offset = 2;
    let frameMarker;
    let frameComponents;
    let sawScan = false;
    while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff)
            return false;
        const markerStart = offset;
        while (offset < bytes.byteLength && bytes[offset] === 0xff)
            offset += 1;
        if (offset >= bytes.byteLength)
            return false;
        const marker = bytes[offset] ?? 0;
        offset += 1;
        if (marker === 0xd9)
            return frameComponents !== undefined && sawScan && offset === bytes.byteLength;
        if (marker === 0x00 || marker === 0xd8)
            return false;
        if (marker === 0x01)
            continue;
        if (marker >= 0xd0 && marker <= 0xd7)
            return false;
        if (offset > bytes.byteLength - 2)
            return false;
        const segmentLength = readU16Be(bytes, offset);
        if (segmentLength < 2 || segmentLength > bytes.byteLength - offset)
            return false;
        if (isStartOfFrameMarker(marker)) {
            if (frameComponents || segmentLength < 8)
                return false;
            const height = readU16Be(bytes, offset + 3);
            const width = readU16Be(bytes, offset + 5);
            const components = bytes[offset + 7] ?? 0;
            if (width === 0 || height === 0 || components === 0 || segmentLength !== 8 + components * 3)
                return false;
            const componentIds = new Set();
            for (let index = 0; index < components; index += 1) {
                const componentOffset = offset + 8 + index * 3;
                const componentId = bytes[componentOffset] ?? -1;
                const sampling = bytes[componentOffset + 1] ?? 0;
                const horizontalSampling = sampling >>> 4;
                const verticalSampling = sampling & 0x0f;
                if (componentIds.has(componentId) ||
                    horizontalSampling === 0 ||
                    horizontalSampling > 4 ||
                    verticalSampling === 0 ||
                    verticalSampling > 4 ||
                    (bytes[componentOffset + 2] ?? 4) > 3) {
                    return false;
                }
                componentIds.add(componentId);
            }
            frameMarker = marker;
            frameComponents = componentIds;
        }
        else if (marker === 0xda) {
            if (!frameComponents || !validJpegScanHeader(bytes, offset, segmentLength, frameComponents, frameMarker)) {
                return false;
            }
        }
        offset += segmentLength;
        if (marker === 0xda) {
            const scan = findNextJpegMarker(bytes, offset);
            if (!scan || !scan.sawEntropy)
                return false;
            sawScan = true;
            offset = scan.markerOffset;
        }
        if (offset <= markerStart)
            return false;
    }
    return false;
}
function validJpegScanHeader(bytes, offset, segmentLength, frameComponents, frameMarker) {
    const components = bytes[offset + 2] ?? 0;
    if (components === 0 || components > frameComponents.size || segmentLength !== 6 + components * 2)
        return false;
    const seen = new Set();
    for (let index = 0; index < components; index += 1) {
        const componentOffset = offset + 3 + index * 2;
        const componentId = bytes[componentOffset] ?? -1;
        const tables = bytes[componentOffset + 1] ?? 0xff;
        if (seen.has(componentId) || !frameComponents.has(componentId) || tables >>> 4 > 3 || (tables & 0x0f) > 3) {
            return false;
        }
        seen.add(componentId);
    }
    const spectralOffset = offset + 3 + components * 2;
    const spectralStart = bytes[spectralOffset] ?? 0xff;
    const spectralEnd = bytes[spectralOffset + 1] ?? 0xff;
    const approximation = bytes[spectralOffset + 2] ?? 0xff;
    const approximationHigh = approximation >>> 4;
    const approximationLow = approximation & 0x0f;
    if (spectralStart > spectralEnd || spectralEnd > 63 || approximationHigh > 13 || approximationLow > 13)
        return false;
    return (frameMarker !== 0xc0 ||
        (spectralStart === 0 && spectralEnd === 63 && approximationHigh === 0 && approximationLow === 0));
}
function isStartOfFrameMarker(marker) {
    return ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf));
}
function findNextJpegMarker(bytes, start) {
    let offset = start;
    let sawEntropy = false;
    while (offset < bytes.byteLength - 1) {
        if (bytes[offset] !== 0xff) {
            sawEntropy = true;
            offset += 1;
            continue;
        }
        let markerOffset = offset;
        while (markerOffset < bytes.byteLength && bytes[markerOffset] === 0xff)
            markerOffset += 1;
        const marker = bytes[markerOffset];
        if (marker === undefined)
            return undefined;
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
            if (marker === 0x00)
                sawEntropy = true;
            offset = markerOffset + 1;
            continue;
        }
        return { markerOffset: offset, sawEntropy };
    }
    return undefined;
}
function isStructurallyValidWebp(bytes) {
    if (bytes.byteLength < 26)
        return false;
    const riffSize = readU32Le(bytes, 4);
    if (riffSize < 18 || riffSize + 8 !== bytes.byteLength)
        return false;
    const first = webpChunkBounds(bytes, 12, bytes.byteLength);
    if (!first)
        return false;
    if (hasAsciiAt(bytes, 12, "VP8 ")) {
        return validVp8Chunk(bytes, first.dataOffset, first.length) && first.nextOffset === bytes.byteLength;
    }
    if (hasAsciiAt(bytes, 12, "VP8L")) {
        return validVp8lChunk(bytes, first.dataOffset, first.length) && first.nextOffset === bytes.byteLength;
    }
    if (!hasAsciiAt(bytes, 12, "VP8X"))
        return false;
    const header = parseVp8xHeader(bytes, first.dataOffset, first.length);
    return header !== undefined && isStructurallyValidExtendedWebp(bytes, first.nextOffset, header);
}
function validVp8Chunk(bytes, offset, length) {
    return readVp8Dimensions(bytes, offset, length) !== undefined;
}
function readVp8Dimensions(bytes, offset, length) {
    if (length <= 10 || bytes[offset + 3] !== 0x9d || bytes[offset + 4] !== 0x01 || bytes[offset + 5] !== 0x2a) {
        return undefined;
    }
    const frameTag = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
    const firstPartitionLength = frameTag >>> 5;
    if ((frameTag & 1) !== 0 ||
        ((frameTag >>> 1) & 0x07) > 3 ||
        ((frameTag >>> 4) & 1) === 0 ||
        firstPartitionLength === 0 ||
        firstPartitionLength > length - 10) {
        return undefined;
    }
    const width = readU16Le(bytes, offset + 6) & 0x3fff;
    const height = readU16Le(bytes, offset + 8) & 0x3fff;
    return width > 0 && height > 0 ? { width, height, usesAlpha: false } : undefined;
}
function validVp8lChunk(bytes, offset, length) {
    return readVp8lDimensions(bytes, offset, length) !== undefined;
}
function readVp8lDimensions(bytes, offset, length) {
    if (length <= 5 || bytes[offset] !== 0x2f)
        return undefined;
    const bits = readU32Le(bytes, offset + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 && bits >>> 29 === 0
        ? { width, height, usesAlpha: ((bits >>> 28) & 1) === 1 }
        : undefined;
}
function parseVp8xHeader(bytes, offset, length) {
    const flags = bytes[offset] ?? 0;
    if (length !== 10 ||
        (flags & 0xc1) !== 0 ||
        bytes[offset + 1] !== 0 ||
        bytes[offset + 2] !== 0 ||
        bytes[offset + 3] !== 0) {
        return undefined;
    }
    const width = 1 + readU24Le(bytes, offset + 4);
    const height = 1 + readU24Le(bytes, offset + 7);
    return width > 0 && height > 0 ? { flags, width, height } : undefined;
}
function webpChunkBounds(bytes, offset, limit) {
    if (offset > limit - 8)
        return undefined;
    const length = readU32Le(bytes, offset + 4);
    const paddedLength = length + (length & 1);
    if (paddedLength < length || paddedLength > limit - offset - 8)
        return undefined;
    const dataOffset = offset + 8;
    if ((length & 1) !== 0 && bytes[dataOffset + length] !== 0)
        return undefined;
    return { dataOffset, length, nextOffset: dataOffset + paddedLength };
}
function isStructurallyValidExtendedWebp(bytes, start, header) {
    const hasAnimationFlag = (header.flags & 0x02) !== 0;
    let offset = start;
    let sawIccp = false;
    let sawAlpha = false;
    let sawImage = false;
    let imageUsesAlpha = false;
    let sawAnim = false;
    let sawFrame = false;
    let frameUsesAlpha = false;
    let sawExif = false;
    let sawXmp = false;
    while (offset < bytes.byteLength) {
        const chunk = webpChunkBounds(bytes, offset, bytes.byteLength);
        if (!chunk)
            return false;
        if (hasAsciiAt(bytes, offset, "VP8X"))
            return false;
        if (hasAsciiAt(bytes, offset, "ICCP")) {
            if (sawIccp || sawImage || sawAnim || chunk.length === 0 || (header.flags & 0x20) === 0)
                return false;
            sawIccp = true;
        }
        else if (hasAsciiAt(bytes, offset, "ALPH")) {
            if (hasAnimationFlag ||
                sawAlpha ||
                sawImage ||
                !validAlphaChunk(bytes, chunk.dataOffset, chunk.length, header.width, header.height)) {
                return false;
            }
            sawAlpha = true;
        }
        else if (hasAsciiAt(bytes, offset, "VP8 ") || hasAsciiAt(bytes, offset, "VP8L")) {
            if (hasAnimationFlag || sawImage || sawExif || sawXmp)
                return false;
            const isLossless = hasAsciiAt(bytes, offset, "VP8L");
            if (isLossless && sawAlpha)
                return false;
            const dimensions = isLossless
                ? readVp8lDimensions(bytes, chunk.dataOffset, chunk.length)
                : readVp8Dimensions(bytes, chunk.dataOffset, chunk.length);
            if (!dimensions || dimensions.width !== header.width || dimensions.height !== header.height)
                return false;
            sawImage = true;
            imageUsesAlpha = isLossless ? dimensions.usesAlpha : sawAlpha;
        }
        else if (hasAsciiAt(bytes, offset, "ANIM")) {
            if (!hasAnimationFlag || sawAnim || sawFrame || chunk.length !== 6)
                return false;
            sawAnim = true;
        }
        else if (hasAsciiAt(bytes, offset, "ANMF")) {
            if (!hasAnimationFlag || !sawAnim || sawExif || sawXmp)
                return false;
            const frame = validateAnmfChunk(bytes, chunk.dataOffset, chunk.length, header.width, header.height);
            if (!frame)
                return false;
            sawFrame = true;
            frameUsesAlpha ||= frame.usesAlpha;
        }
        else if (hasAsciiAt(bytes, offset, "EXIF")) {
            if (sawExif || chunk.length === 0 || (header.flags & 0x08) === 0 || !(sawImage || sawFrame))
                return false;
            sawExif = true;
        }
        else if (hasAsciiAt(bytes, offset, "XMP ")) {
            if (sawXmp || chunk.length === 0 || (header.flags & 0x04) === 0 || !(sawImage || sawFrame))
                return false;
            sawXmp = true;
        }
        offset = chunk.nextOffset;
    }
    if (offset !== bytes.byteLength)
        return false;
    if (((header.flags & 0x20) !== 0) !== sawIccp)
        return false;
    if (((header.flags & 0x08) !== 0) !== sawExif || ((header.flags & 0x04) !== 0) !== sawXmp)
        return false;
    const advertisedAlpha = (header.flags & 0x10) !== 0;
    return hasAnimationFlag
        ? sawAnim && sawFrame && advertisedAlpha === frameUsesAlpha
        : sawImage && advertisedAlpha === imageUsesAlpha;
}
function validAlphaChunk(bytes, offset, length, width, height) {
    if (length < 2)
        return false;
    const header = bytes[offset] ?? 0xff;
    const compression = header & 0x03;
    if ((header & 0xc0) !== 0 || compression > 1 || ((header >>> 4) & 0x03) > 1)
        return false;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
        return false;
    if (width > Number.MAX_SAFE_INTEGER / height)
        return false;
    const payloadLength = length - 1;
    return compression === 0 ? payloadLength === width * height : payloadLength > 0;
}
function validateAnmfChunk(bytes, offset, length, canvasWidth, canvasHeight) {
    if (length < 30)
        return undefined;
    const x = readU24Le(bytes, offset) * 2;
    const y = readU24Le(bytes, offset + 3) * 2;
    const width = readU24Le(bytes, offset + 6) + 1;
    const height = readU24Le(bytes, offset + 9) + 1;
    if ((bytes[offset + 15] ?? 0xff) & 0xfc)
        return undefined;
    if (x + width > canvasWidth || y + height > canvasHeight)
        return undefined;
    const limit = offset + length;
    let chunkOffset = offset + 16;
    let sawAlpha = false;
    let dimensions;
    while (chunkOffset < limit) {
        const chunk = webpChunkBounds(bytes, chunkOffset, limit);
        if (!chunk)
            return undefined;
        if (hasAsciiAt(bytes, chunkOffset, "ALPH")) {
            if (sawAlpha || dimensions || !validAlphaChunk(bytes, chunk.dataOffset, chunk.length, width, height)) {
                return undefined;
            }
            sawAlpha = true;
        }
        else if (hasAsciiAt(bytes, chunkOffset, "VP8 ")) {
            if (dimensions)
                return undefined;
            const lossy = readVp8Dimensions(bytes, chunk.dataOffset, chunk.length);
            if (!lossy)
                return undefined;
            dimensions = { ...lossy, usesAlpha: sawAlpha };
        }
        else if (hasAsciiAt(bytes, chunkOffset, "VP8L")) {
            if (dimensions || sawAlpha)
                return undefined;
            dimensions = readVp8lDimensions(bytes, chunk.dataOffset, chunk.length);
        }
        else {
            return undefined;
        }
        chunkOffset = chunk.nextOffset;
    }
    return dimensions && dimensions.width === width && dimensions.height === height
        ? { usesAlpha: dimensions.usesAlpha }
        : undefined;
}
function readU16Be(bytes, offset) {
    return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}
function readU16Le(bytes, offset) {
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}
function readU24Le(bytes, offset) {
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}
function readU32Be(bytes, offset) {
    return (((bytes[offset] ?? 0) * 0x1_00_00_00 +
        (bytes[offset + 1] ?? 0) * 0x1_00_00 +
        (bytes[offset + 2] ?? 0) * 0x1_00 +
        (bytes[offset + 3] ?? 0)) >>>
        0);
}
function readU32Le(bytes, offset) {
    return (((bytes[offset] ?? 0) +
        (bytes[offset + 1] ?? 0) * 0x1_00 +
        (bytes[offset + 2] ?? 0) * 0x1_00_00 +
        (bytes[offset + 3] ?? 0) * 0x1_00_00_00) >>>
        0);
}
function hasAsciiAt(bytes, offset, value) {
    for (let index = 0; index < value.length; index += 1) {
        if (bytes[offset + index] !== value.charCodeAt(index))
            return false;
    }
    return true;
}
function crc32(bytes, start, end) {
    let crc = 0xffff_ffff;
    for (let index = start; index < end; index += 1) {
        crc ^= bytes[index] ?? 0;
        for (let bit = 0; bit < 8; bit += 1)
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
    return (crc ^ 0xffff_ffff) >>> 0;
}
function copyBoundedBytes(value) {
    try {
        if (typeof value !== "object" || value === null)
            fail("corrupt_blob");
        const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
        if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > AGENT_V2_INPUT_LIMITS.maxImageBytes) {
            fail("limit_exceeded");
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Uint8Array.prototype && !Buffer.isBuffer(value))
            fail("corrupt_blob");
        const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []);
        const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
        if (!(buffer instanceof ArrayBuffer))
            fail("corrupt_blob");
        const bufferByteLength = Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, buffer, []);
        if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset + byteLength > bufferByteLength) {
            fail("corrupt_blob");
        }
        return new Uint8Array(new Uint8Array(buffer, byteOffset, byteLength));
    }
    catch (error) {
        rethrowKnownOrFail(error, "corrupt_blob");
    }
}
async function settleStoreCall(call, signal) {
    throwIfAborted(signal);
    let abortListener;
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    try {
        abortListener = () => rejectAbort(new AgentV2InputAbortError());
        Reflect.apply(EVENT_TARGET_ADD_EVENT_LISTENER, signal, ["abort", abortListener, { once: true }]);
        throwIfAborted(signal);
    }
    catch (error) {
        safelyRemoveAbortListener(signal, abortListener);
        if (isAbortError(error))
            throw new AgentV2InputAbortError();
        fail("store_failure");
    }
    const promise = Promise.resolve().then(() => {
        throwIfAborted(signal);
        return call();
    });
    try {
        const value = await Promise.race([promise, aborted]);
        throwIfAborted(signal);
        return value;
    }
    catch (error) {
        if (isAbortError(error))
            throw new AgentV2InputAbortError();
        const abortedState = signalAbortedState(signal);
        if (abortedState === true)
            throw new AgentV2InputAbortError();
        return fail("store_failure");
    }
    finally {
        safelyRemoveAbortListener(signal, abortListener);
    }
}
function authorizedReference(reference) {
    return {
        kind: reference.kind,
        inputId: reference.inputId,
        logicalPath: reference.logicalPath,
        mediaType: reference.mediaType,
        byteLength: reference.byteLength,
        checksum: reference.checksum,
    };
}
function sameReference(left, right) {
    return (left.clientId === right.clientId &&
        left.runId === right.runId &&
        left.kind === right.kind &&
        left.ordinal === right.ordinal &&
        left.inputId === right.inputId &&
        left.logicalPath === right.logicalPath &&
        left.displayName === right.displayName &&
        left.mediaType === right.mediaType &&
        left.byteLength === right.byteLength &&
        left.checksum === right.checksum);
}
function sameContentIdentity(left, right) {
    return (left.inputId === right.inputId &&
        left.logicalPath === right.logicalPath &&
        left.mediaType === right.mediaType &&
        left.byteLength === right.byteLength &&
        left.checksum === right.checksum);
}
function compareReferenceSemantics(left, right) {
    const kind = kindRank(left.kind) - kindRank(right.kind);
    if (kind !== 0)
        return kind;
    if (left.ordinal !== right.ordinal)
        return left.ordinal - right.ordinal;
    return asciiCompare(left.inputId, right.inputId);
}
function kindRank(kind) {
    return kind === "project_file" ? 0 : 1;
}
function asciiCompare(left, right) {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const difference = left.charCodeAt(index) - right.charCodeAt(index);
        if (difference !== 0)
            return difference;
    }
    return left.length - right.length;
}
function hasPrefix(bytes, prefix) {
    if (bytes.byteLength < prefix.length)
        return false;
    for (let index = 0; index < prefix.length; index += 1) {
        if (bytes[index] !== prefix[index])
            return false;
    }
    return true;
}
function plainRecord(value, code) {
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype)
        fail(code);
    return value;
}
function assertOnlyFields(record, allowed, code) {
    const keys = Reflect.ownKeys(record);
    if (keys.length > allowed.size)
        fail(code);
    for (const key of keys) {
        if (typeof key !== "string" || !allowed.has(key))
            fail(code);
        if (!isDataDescriptor(Object.getOwnPropertyDescriptor(record, key)))
            fail(code);
    }
}
function dataValue(record, key, code) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!isDataDescriptor(descriptor))
        fail(code);
    return descriptor.value;
}
function isDataDescriptor(value) {
    return value !== undefined && Object.hasOwn(value, "value") && value.get === undefined && value.set === undefined;
}
function boundedString(value, maxCodeUnits, code = "authorization_mismatch") {
    if (typeof value !== "string" || value.length === 0 || value.length > maxCodeUnits)
        fail(code);
    return value;
}
function throwIfAborted(signal) {
    const aborted = signalAbortedState(signal);
    if (aborted === undefined)
        fail("store_failure");
    if (aborted)
        throw new AgentV2InputAbortError();
}
function isAbortError(value) {
    return (typeof value === "object" && value !== null) || typeof value === "function"
        ? ABORT_ERRORS.has(value)
        : false;
}
function signalAbortedState(signal) {
    try {
        const value = Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER, signal, []);
        return typeof value === "boolean" ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function fail(code) {
    const validatedCode = validatedMaterializationErrorCode(code);
    const error = new AgentV2InputMaterializationError(validatedCode);
    MATERIALIZATION_ERROR_CODES.set(error, validatedCode);
    throw error;
}
function rethrowKnownOrFail(error, fallback) {
    if (isAbortError(error))
        throw new AgentV2InputAbortError();
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
        const code = MATERIALIZATION_ERROR_CODES.get(error);
        if (code !== undefined)
            fail(code);
    }
    fail(fallback);
}
function validatedMaterializationErrorCode(code) {
    switch (code) {
        case "authorization_mismatch":
        case "missing_blob":
        case "corrupt_blob":
        case "integrity_mismatch":
        case "unsupported_media":
        case "limit_exceeded":
        case "store_failure":
            return code;
        default:
            return "store_failure";
    }
}
function safelyRemoveAbortListener(signal, listener) {
    if (!listener)
        return;
    try {
        Reflect.apply(EVENT_TARGET_REMOVE_EVENT_LISTENER, signal, ["abort", listener]);
    }
    catch {
        // Invalid or hostile signal receivers are already reported through the stable store_failure boundary.
    }
}
function canonicalTimestamp(value, code) {
    if (typeof value !== "string" || value.length !== 24)
        fail(code);
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value)
        fail(code);
    return value;
}
function requireGetter(prototype, key) {
    const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
    if (!getter)
        throw new Error(`Missing required platform getter: ${key}`);
    return getter;
}
//# sourceMappingURL=agent-v2-input-materializer.js.map