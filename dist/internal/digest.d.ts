import { type RecordBody } from './local-record.js';
export declare const legacyDigestVersion = "legacy-v0.1";
export declare const currentDigestVersion = "utf16-v1";
export type DigestVersion = typeof legacyDigestVersion | typeof currentDigestVersion;
export type SnapshotChecksum = (payload: unknown) => string;
/**
 * utf16-v1 hashes compact UTF-8 JSON after validating and copying the input.
 * The copy preserves array order, sorts object keys by UTF-16 code units, and
 * normalizes signed zero. JSON.stringify emits array-index keys first in numeric
 * order. Strings retain their original code units.
 */
export declare function computeSnapshotChecksum(payload: unknown): string;
export declare function computeRecordEnvelopeChecksum(envelope: {
    schemaVersion: string;
    digestVersion: DigestVersion;
    record: RecordBody;
}): string;
/** v0.1.0 used the default Node/ICU localeCompare ordering with stable ties. */
export declare function createLegacySnapshotChecksum(locale?: string): SnapshotChecksum;
