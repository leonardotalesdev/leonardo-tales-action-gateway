import { type DigestVersion } from './digest.js';
import { type ReconciliationRecord } from './reconciliation-record.js';
import type { ExactActionBinding } from './gateway-contract.js';
import { type LocalRecord, type LocalRecordPort } from './local-store.js';
type AllowanceReadPort = Pick<LocalRecordPort, 'read' | 'list' | 'checksumFor'>;
type ReconciliationDecisions = ReadonlyMap<string, ReconciliationRecord>;
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
    verifyManifest: (port: AllowanceReadPort & Partial<Pick<LocalRecordPort, "create">>, mode?: "existing" | "initialize" | "inspect") => Promise<void>;
    read: (port: Pick<LocalRecordPort, "read">, key: string) => Promise<Readonly<{
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
    snapshot: (port: AllowanceReadPort, key?: string, decisions?: ReconciliationDecisions, rows?: readonly LocalRecord[]) => Promise<{
        totals: {
            cap: number;
            settled: number;
            held: number;
            remaining: number;
        };
        selected: {
            value: Operation;
            result: Awaited<ReturnType<(port: AllowanceReadPort, value: Operation, decision?: ReconciliationRecord) => Promise<Readonly<{
                status: "confirmed-success";
                evidenceRef: import("./task-run.js").RunReference;
            }> | Readonly<{
                status: "confirmed-failure";
                effect: "not-performed" | "terminal-no-retry";
                evidenceRef: import("./task-run.js").RunReference;
            }> | Readonly<{
                status: "unknown";
            }> | {
                status: "reconciled-effect" | "reconciled-no-effect";
                evidenceRef: Readonly<{
                    id: string;
                    revision: number;
                }>;
            } | null>>>;
        } | undefined;
    }>;
    reserve: (port: LocalRecordPort, key: string, binding: ExactActionBinding, version: DigestVersion, view?: Readonly<{
        port: AllowanceReadPort;
        decisions: ReconciliationDecisions;
        rows: readonly LocalRecord[];
    }>) => Promise<boolean>;
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
export {};
