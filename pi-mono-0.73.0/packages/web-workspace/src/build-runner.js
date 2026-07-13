export class BuildRunnerError extends Error {
    code;
    logs;
    constructor(code, message, logs) {
        super(message);
        this.code = code;
        this.logs = logs;
        this.name = "BuildRunnerError";
    }
}
//# sourceMappingURL=build-runner.js.map