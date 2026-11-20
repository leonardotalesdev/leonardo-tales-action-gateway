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
export declare function localId(value: unknown): value is string;
export declare function localRevision(value: unknown): value is number;
export declare function localTimestamp(value: unknown): value is string;
export declare function localObject(value: unknown, keys: readonly string[]): Record<string, unknown>;
/** Explicit trusted-host storage adapter. No default path, agent tool or auto-recovery. */
export declare function openLocalRecordStore(directory: string, projectId: string, options?: LocalStoreOptions & {
    legacyDigestLocale?: string;
}): Promise<LocalTransactionalRecordPort>;
/** Append-only API; full-file atomic replacement keeps partial JSONL tails out of history. */
export declare function openLocalAuditPort(directory: string, projectId: string, options?: LocalStoreOptions): Promise<LocalAuditPort>;
