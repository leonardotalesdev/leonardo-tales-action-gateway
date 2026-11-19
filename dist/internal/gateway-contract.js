export class ExecutionGatewayError extends Error {
    code;
    constructor(code) { super(code); this.code = code; }
}
