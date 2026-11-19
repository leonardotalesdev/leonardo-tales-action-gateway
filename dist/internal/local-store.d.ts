export type LocalStoreErrorCode = 'invalid-record' | 'invalid-id' | 'unsafe-path' | 'locked' | 'already-exists' | 'stale-revision' | 'corrupt-record' | 'write-uncertain' | 'io-error';
export declare class LocalStoreError extends Error {
    readonly code: LocalStoreErrorCode;
    constructor(code: LocalStoreErrorCode);
}
export type LocalRecord = Readonly<{
    kind: string;
    id: string;
    projectId: string;
    revision: number;
    payload: unknown;
}>;
export type LocalRecordPort = Readonly<{
    read(kind: string, id: string): Promise<LocalRecord | null>;
    list(kind: string): Promise<readonly LocalRecord[]>;
    create(record: LocalRecord): Promise<void>;
    save(record: LocalRecord, expectedRevision: number): Promise<void>;
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
/** Strict JSON boundary before the existing canonical checksum helper is used. */
export declare function copyLocalJson(value: unknown, depth?: number, budget?: {
    nodes: number;
}): unknown;
export declare function localRecord(value: unknown): LocalRecord;
/** Explicit trusted-host storage adapter. No default path, agent tool or auto-recovery. */
export declare function openLocalRecordStore(directory: string, projectId: string, options?: LocalStoreOptions): Promise<LocalTransactionalRecordPort>;
/** Append-only API; full-file atomic replacement keeps partial JSONL tails out of history. */
export declare function openLocalAuditPort(directory: string, projectId: string, options?: LocalStoreOptions): Promise<LocalAuditPort>;
