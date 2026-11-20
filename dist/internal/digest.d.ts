export declare const legacyDigestVersion = "legacy-v0.1";
export declare const currentDigestVersion = "utf16-v1";
export type DigestVersion = typeof legacyDigestVersion | typeof currentDigestVersion;
export type SnapshotChecksum = (payload: unknown) => string;
/**
 * utf16-v1: SHA-256 of compact UTF-8 JSON. Round-trip through JSON first,
 * preserve array order, and sort object keys by UTF-16 code units. JSON.stringify
 * emits array-index keys first in numeric order. Strings retain their original
 * code units and JSON numbers normalize signed zero.
 */
export declare function computeSnapshotChecksum(payload: unknown): string;
/** v0.1.0 used the default Node/ICU localeCompare ordering with stable ties. */
export declare function createLegacySnapshotChecksum(locale?: string): SnapshotChecksum;
