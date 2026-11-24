export type ExecutionAuditEventType = 'action-proposed' | 'policy-evaluated' | 'approval-requested' | 'approval-recorded' | 'execution-authority-granted' | 'execution-started' | 'execution-result-recorded' | 'reconciliation-started' | 'reconciliation-completed' | 'reconciliation-decision-qualified';
export type ExecutionAuditEvent = Readonly<{
    schemaVersion: 'execution-audit-event/v0.1';
    id: string;
    projectId: string;
    taskId: string;
    runId: string;
    occurredAt: string;
    type: ExecutionAuditEventType;
    actorId: string;
    observationCode: string;
    subjectRef: Readonly<{
        kind: 'proposal' | 'run' | 'execution' | 'artifact';
        id: string;
        revision: number;
    }>;
}>;
export type ExecutionAuditEnvelope = Readonly<{
    schemaVersion: 'execution-audit-envelope/v0.1';
    sequence: number;
    event: ExecutionAuditEvent;
    previousHash: string | null;
    eventHash: string;
    chainHash: string;
}>;
/** The adapter exposes append only, never truncate/update; it serializes builders under a local lock. */
export type ExecutionAuditPort = Readonly<{
    read(): Promise<string>;
    appendLine(build: (history: string) => string | null): Promise<string | null>;
}>;
export declare class ExecutionAuditError extends Error {
    readonly code: 'invalid-event' | 'corrupt-audit' | 'event-conflict';
    constructor(code: ExecutionAuditError['code']);
}
export declare function validateExecutionAuditEvent(value: unknown): ExecutionAuditEvent;
export declare function readExecutionAudit(text: string, projectId: string): readonly ExecutionAuditEnvelope[];
/** Historical observations only. Reading this log can never restore workflow or execution authority. */
export declare function createExecutionAuditStore(port: ExecutionAuditPort, projectId: string): Readonly<{
    read(): Promise<readonly Readonly<{
        schemaVersion: "execution-audit-envelope/v0.1";
        sequence: number;
        event: ExecutionAuditEvent;
        previousHash: string | null;
        eventHash: string;
        chainHash: string;
    }>[]>;
    append(value: ExecutionAuditEvent, verifyHistory?: (records: readonly ExecutionAuditEnvelope[]) => void): Promise<ExecutionAuditEnvelope>;
}>;
