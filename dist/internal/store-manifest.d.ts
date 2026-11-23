import { type LocalRecord, type LocalRecordPort } from './local-store.js';
export type TaskSettings = Readonly<{
    id: string;
    cap: number;
    unit: string;
    expiresAt: string;
}>;
export declare function taskStoreIdentity(id: string): {
    projectId: `project-action-${string}`;
    taskId: `task-action-${string}`;
};
export declare function projectManifest(record: LocalRecord, projectId: string, checksumFor: LocalRecordPort['checksumFor']): {
    configuration: Readonly<{
        schemaVersion: "action-allowance/v0.1";
        task: TaskSettings;
        action: string;
        revision: number;
        approverId: string;
        timeoutMs: number;
    }>;
    storeGeneration: null;
} | {
    configuration: Readonly<{
        schemaVersion: "action-allowance/v0.1";
        task: TaskSettings;
        action: string;
        revision: number;
        approverId: string;
        timeoutMs: number;
    }>;
    storeGeneration: string;
};
