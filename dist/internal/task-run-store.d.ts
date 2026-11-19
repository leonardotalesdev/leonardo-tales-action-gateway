import { type Task, type Run } from './task-run.js';
/** Replaceable storage port; only the host adapter knows filesystem paths. */
export type StateRecord = Readonly<{
    kind: string;
    id: string;
    projectId: string;
    revision: number;
    payload: unknown;
}>;
export type TaskRunStoragePort = Readonly<{
    read(kind: string, id: string): Promise<StateRecord | null>;
    list(kind: string): Promise<readonly StateRecord[]>;
    create(record: StateRecord): Promise<void>;
    save(record: StateRecord, expectedRevision: number): Promise<void>;
}>;
export declare class TaskRunStorageError extends Error {
    readonly code: 'invalid-state' | 'missing-task' | 'stale-revision';
    constructor(code: TaskRunStorageError['code']);
}
export type StoredTask = Readonly<{
    revision: number;
    task: Task;
}>;
export declare function restoreTask(value: unknown): Task;
/** Replay validated M1 receipts; a checksum alone cannot establish domain validity. */
export declare function restoreRun(task: Task, value: unknown): Run;
/** Workflow persistence only: no proposals, approval evidence or execution authority are loaded here. */
export declare function createTaskRunStore(port: TaskRunStoragePort, projectId: Task['projectId']): Readonly<{
    loadTask: (id: Task["id"]) => Promise<StoredTask | null>;
    loadRun: (id: Run["id"]) => Promise<Run | null>;
    createTask(value: Task): Promise<StoredTask>;
    saveTask(value: Task, expectedRevision: number): Promise<StoredTask>;
    createRun(value: Run): Promise<Run>;
    saveRun(value: Run, expectedRevision: number): Promise<Run>;
    listRuns(taskId: Task["id"]): Promise<readonly Run[]>;
}>;
