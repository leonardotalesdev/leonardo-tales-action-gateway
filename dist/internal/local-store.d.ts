import { type DigestVersion, type SnapshotChecksum } from './digest.js';
import { type RecordBody } from './local-record.js';
export { copyLocalJson, LocalStoreError, type LocalStoreErrorCode } from './local-record.js';
export type LocalRecord = RecordBody & Readonly<{
    digestVersion: DigestVersion;
}>;
type RecordWrite = RecordBody & Readonly<{
    digestVersion?: DigestVersion;
}>;
export type LocalRecordPort = Readonly<{
    checksumFor(version: DigestVersion): SnapshotChecksum;
    read(kind: string, id: string): Promise<LocalRecord | null>;
    list(kind: string): Promise<readonly LocalRecord[]>;
    create(record: RecordWrite): Promise<void>;
    save(record: RecordWrite, expectedRevision: number): Promise<void>;
}>;
/** Trusted host critical section. Its scoped port expires when the callback settles. */
export type LocalTransactionalRecordPort = LocalRecordPort & Readonly<{
    exclusive<T>(work: (port: LocalRecordPort) => Promise<T>): Promise<T>;
}>;
export type LocalAuditPort = Readonly<{
    read(): Promise<string>;
    appendLine(build: (history: string) => string | null): Promise<string | null>;
}>;
/** Fault-injection checkpoints for offline tests, never supplied by an agent. */
export type LocalStoreOptions = Readonly<{
    checkpoint?: (stage: 'temporary-synced' | 'renamed' | 'directory-synced') => void | Promise<void>;
}>;
export declare const actionAllowanceKind = "action-allowance";
export declare const taskManifestId = "task-allowance";
export declare function localId(value: unknown): value is string;
export declare function localRevision(value: unknown): value is number;
export declare function localTimestamp(value: unknown): value is string;
export declare function localObject(value: unknown, keys: readonly string[]): Record<string, unknown>;
export declare function canonicalGatewayPath(path: string): boolean;
type RecordEnvelope = Readonly<{
    schemaVersion: 'local-record-envelope/v0.1';
    record: RecordBody;
    checksum: string;
}> | Readonly<{
    schemaVersion: 'local-record-envelope/v0.2';
    digestVersion: DigestVersion;
    record: RecordBody;
    checksum: string;
}>;
type VerifiedRecord = Readonly<{
    envelope: RecordEnvelope;
    record: LocalRecord;
}>;
export declare function verifyRecordEnvelope(value: unknown, projectId: string, kind: string, checksumFor: LocalRecordPort['checksumFor'], id?: string): VerifiedRecord;
export declare function encodeRecordEnvelope(record: RecordBody, digestVersion?: DigestVersion): {
    checksum: string;
    schemaVersion: "local-record-envelope/v0.2";
    digestVersion: DigestVersion;
    record: Readonly<{
        kind: string;
        id: string;
        projectId: string;
        revision: number;
        payload: unknown;
    }>;
};
/** Explicit trusted-host storage adapter. No default path, agent tool or auto-recovery. */
export declare function openLocalRecordStore(directory: string, projectId: string, options?: LocalStoreOptions & {
    legacyDigestLocale?: string;
}): Promise<LocalTransactionalRecordPort>;
/** Append-only API; full-file atomic replacement keeps partial JSONL tails out of history. */
export declare function openLocalAuditPort(directory: string, projectId: string, options?: LocalStoreOptions): Promise<LocalAuditPort>;
/** Existing Task paths only. The writer can replace just the canonical manifest. */
export declare function openExistingPromotionStore(directory: string, projectId: string, checksumFor: LocalRecordPort['checksumFor'], options: LocalStoreOptions): Promise<{
    snapshot: () => Promise<{
        records: Map<string, Readonly<{
            envelope: RecordEnvelope;
            record: LocalRecord;
        }>[]>;
        audit: string;
        fingerprint: string;
    }>;
    requireStateUnlocked: () => Promise<void>;
    requireAuditUnlocked: () => Promise<void>;
    exclusive<T>(work: (manifest: {
        read: () => Promise<Readonly<{
            envelope: RecordEnvelope;
            record: LocalRecord;
        }>>;
        replace(candidate: RecordEnvelope): Promise<void>;
        sync(): Promise<void>;
    }) => Promise<T>): Promise<T>;
}>;
