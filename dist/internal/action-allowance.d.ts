import { type DigestVersion } from './digest.js';
import type { ExactActionBinding } from './gateway-contract.js';
import { type LocalRecord, type LocalRecordPort } from './local-store.js';
export type RefusalBalance = Readonly<{
    reason: 'task_limit';
    cap: number;
    settled: number;
    held: number;
    remaining: number;
}>;
export type Operation = Readonly<{
    digestVersion: DigestVersion;
    key: string;
    runId: string;
    runRevision: number;
    createdAt: string;
    inputDigest: string;
    proposalDigest: string;
    amount: number;
    phase: 'pending' | 'held' | 'blocked';
    binding: ExactActionBinding | null;
    refusalBasis?: RefusalBalance;
}>;
export declare function operationId(key: string): string;
export declare function nativeRunId(id: string): `run-${string}`;
export declare function positiveInteger(value: unknown): value is number;
export declare function createTaskAllowance(projectId: string, taskId: string, cap: number, manifest: object): {
    verifyManifest: (port: LocalRecordPort, initialize?: boolean) => Promise<void>;
    read: (port: LocalRecordPort, key: string) => Promise<Readonly<{
        digestVersion: DigestVersion;
        key: string;
        runId: string;
        runRevision: number;
        createdAt: string;
        inputDigest: string;
        proposalDigest: string;
        amount: number;
        phase: "pending" | "held" | "blocked";
        binding: ExactActionBinding | null;
        refusalBasis?: RefusalBalance;
    }> | null>;
    register: (port: LocalRecordPort, { digestVersion, ...value }: Operation) => Promise<void>;
    snapshot: (port: LocalRecordPort, key?: string) => Promise<{
        totals: {
            cap: number;
            settled: number;
            held: number;
            remaining: number;
        };
        selected: {
            value: Operation;
            result: Awaited<ReturnType<(port: LocalRecordPort, value: Operation) => Promise<import("./gateway-contract.js").ExecutionAdapterResult | null>>>;
        } | undefined;
    }>;
    reserve: (port: LocalRecordPort, key: string, binding: ExactActionBinding, version: DigestVersion) => Promise<boolean>;
    parseOperation: (record: LocalRecord) => Readonly<{
        digestVersion: DigestVersion;
        key: string;
        runId: string;
        runRevision: number;
        createdAt: string;
        inputDigest: string;
        proposalDigest: string;
        amount: number;
        phase: "pending" | "held" | "blocked";
        binding: ExactActionBinding | null;
        refusalBasis?: RefusalBalance;
    }>;
};
