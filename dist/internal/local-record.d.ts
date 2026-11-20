export type LocalStoreErrorCode = 'invalid-record' | 'invalid-id' | 'unsafe-path' | 'locked' | 'already-exists' | 'stale-revision' | 'corrupt-record' | 'write-uncertain' | 'io-error';
export declare class LocalStoreError extends Error {
    readonly code: LocalStoreErrorCode;
    constructor(code: LocalStoreErrorCode);
}
export type RecordBody = Readonly<{
    kind: string;
    id: string;
    projectId: string;
    revision: number;
    payload: unknown;
}>;
export declare const maxBytes: number;
/** Strict JSON boundary before hashing or writing a record. */
export declare function copyLocalJson(value: unknown, depth?: number, budget?: {
    nodes: number;
}): unknown;
