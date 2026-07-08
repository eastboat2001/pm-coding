import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
// Import workspace runtime sources directly so this test cannot pass against stale dist output.
import type { RedisAgentV2RunEventBusOptions } from "../../../packages/web-workspace/src/agent-v2-run-event-bus.js";
import { loadStorageConfig } from "../../../packages/web-workspace/src/config.js";
import { RuntimeDbStore } from "../../../packages/web-workspace/src/runtime-db.js";
import { InMemoryRunQueue } from "../../../packages/web-workspace/src/run-queue.js";
import { WorkspaceRunWorkerService } from "../../../packages/web-workspace/src/run-worker-service.js";
import type {
  JsonObject,
  RedisRunEventBusOptions,
  RunEventSinkOptions,
  WorkerAgentInput,
} from "../../../packages/web-workspace/src/index.js";
import {
  createAgentV2WorkerExecution,
  createAgentV2WorkerRunEventOptions,
  createWorkerStartupDiagnosticEvents,
} from "../src/worker/main.js";
import {
  createRunAgent,
  createWorkerRunEventOptions,
} from "../src/worker/legacy-v1-main.js";

describe("worker runtime diagnostics", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { force: true, recursive: true });
    dir = undefined;
  });

  it("wraps worker model streams with provider diagnostics", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-diagnostics-"));
    const diagnostics = new RecordingDiagnostics();
    const input = createWorkerInput();
    const model = input.model as Model<any>;
    let observedMaxTokens: number | undefined;
    const agent = createRunAgent(input, {
      config: { ...loadStorageConfig(dir), modelMaxOutputTokens: 1234 },
      diagnostics,
      skills: { load: () => ({ name: "unused", content: "unused" }) },
      promptSkills: [],
      defaultSkills: [],
      streamFn: async (
        _model: Model<any>,
        _context: Context,
        options?: SimpleStreamOptions,
      ) => {
        observedMaxTokens = options?.maxTokens;
        await options?.onPayload?.(
          { messages: [{ role: "user", content: "hello" }] },
          model,
        );
        await options?.onResponse?.(
          { status: 200, headers: { "x-request-id": "worker-upstream" } },
          model,
        );
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = createAssistantMessage();
          stream.push({ type: "start", partial: message });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "done",
            partial: message,
          });
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
    });

    await agent.prompt(input.messages.at(-1)!);

    expect(observedMaxTokens).toBe(1234);
    expect(diagnostics.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientId: "client-a",
          sessionId: "session-1",
          traceId: "session-1",
          eventType: "provider.request.start",
          provider: "Test Provider",
          model: "test-model",
        }),
        expect.objectContaining({
          clientId: "client-a",
          sessionId: "session-1",
          traceId: "session-1",
          eventType: "provider.payload",
        }),
        expect.objectContaining({
          clientId: "client-a",
          sessionId: "session-1",
          traceId: "session-1",
          eventType: "provider.response",
        }),
        expect.objectContaining({
          clientId: "client-a",
          sessionId: "session-1",
          traceId: "session-1",
          eventType: "model.stream.summary",
          data: expect.objectContaining({ textChars: 4 }),
        }),
      ]),
    );
  });

  it("uses worker config for stalled provider stream idle timeout", async () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-idle-timeout-"));
    const diagnostics = new RecordingDiagnostics();
    const input = createWorkerInput();
    const config = {
      ...loadStorageConfig(dir),
      modelStreamIdleTimeoutMs: 25,
    } as ReturnType<typeof loadStorageConfig> & {
      modelStreamIdleTimeoutMs: number;
    };
    const stalledStream = createAssistantMessageEventStream();
    let promptPromise: Promise<void> | undefined;

    try {
      const agent = createRunAgent(input, {
        config,
        diagnostics,
        skills: { load: () => ({ name: "unused", content: "unused" }) },
        promptSkills: [],
        defaultSkills: [],
        streamFn: async () => stalledStream,
      });

      promptPromise = agent.prompt(input.messages.at(-1)!);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(26);
      await Promise.resolve();
      await Promise.resolve();

      expect(diagnostics.events).toContainEqual(
        expect.objectContaining({
          eventType: "model.stream.summary",
          level: "error",
          data: expect.objectContaining({
            stopReason: "error",
            errorMessage: expect.stringContaining(
              "Model stream stalled for 25ms without events",
            ),
          }),
        }),
      );
    } finally {
      if (promptPromise) {
        const message = createAssistantMessage({ text: "cleanup" });
        stalledStream.push({ type: "done", reason: "stop", message });
        await promptPromise.catch(() => {});
      }
      vi.useRealTimers();
    }
  });

  it("injects worker capability plans into the model context and diagnostics", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-capability-plan-"));
    const diagnostics = new RecordingDiagnostics();
    const input = createWorkerInput({
      content:
        "Build a full-stack app with backend APIs, PostgreSQL persistence, and auth.",
    });
    let observedSystemPrompt = "";
    const agent = createRunAgent(input, {
      config: loadStorageConfig(dir),
      diagnostics,
      skills: { load: () => ({ name: "unused", content: "unused" }) },
      promptSkills: [],
      defaultSkills: [],
      streamFn: async (_model: Model<any>, context: Context) => {
        observedSystemPrompt = context.systemPrompt ?? "";
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = createAssistantMessage({ text: "done" });
          stream.push({ type: "start", partial: message });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "done",
            partial: message,
          });
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
    });

    await agent.prompt(input.messages.at(-1)!);

    expect(observedSystemPrompt).toContain("<capability_plan>");
    expect(observedSystemPrompt).toContain("delivery_mode: static_simulation");
    expect(observedSystemPrompt).toContain(
      "unsupported_capabilities: backend_server, database_runtime, server_auth",
    );
    expect(observedSystemPrompt).toContain("<spec_artifact>");
    expect(observedSystemPrompt).toContain(
      "First preview must render meaningful first-screen data",
    );
    expect(observedSystemPrompt).toContain("<spec_execution_contract>");
    expect(observedSystemPrompt).toContain("docs/spec.md");
    expect(observedSystemPrompt).toContain("docs/plan.md");
    expect(observedSystemPrompt).toContain("docs/tasks.md");
    expect(diagnostics.events).toContainEqual(
      expect.objectContaining({
        clientId: "client-a",
        sessionId: "session-1",
        traceId: "session-1",
        eventType: "model.capability_plan",
        data: expect.objectContaining({
          deliveryMode: "static_simulation",
          unsupportedCapabilities: expect.arrayContaining([
            "backend_server",
            "database_runtime",
            "server_auth",
          ]),
        }),
      }),
    );
    expect(diagnostics.events).toContainEqual(
      expect.objectContaining({
        clientId: "client-a",
        sessionId: "session-1",
        traceId: "session-1",
        eventType: "model.spec_artifact",
        data: expect.objectContaining({
          deliveryMode: "static_simulation",
          objective: expect.stringContaining("full-stack app"),
          qualityGates: expect.arrayContaining([
            "project_task validate",
            "static_preview_smoke_gate",
          ]),
          taskChecklist: expect.arrayContaining([
            expect.stringContaining(
              "Read `docs/spec.md`, `docs/plan.md`, `docs/tasks.md`",
            ),
          ]),
        }),
      }),
    );
    expect(diagnostics.events).toContainEqual(
      expect.objectContaining({
        clientId: "client-a",
        sessionId: "session-1",
        traceId: "session-1",
        eventType: "model.context_packet",
        data: expect.objectContaining({
          packet: expect.objectContaining({
            currentObjective: expect.stringContaining("full-stack app"),
            requirementsSummary: expect.arrayContaining([
              expect.stringContaining("backend APIs"),
            ]),
            specExecution: expect.objectContaining({
              requiredReads: expect.arrayContaining([
                "docs/spec.md",
                "docs/plan.md",
                "docs/tasks.md",
              ]),
              requiredBeforeImplementation: true,
            }),
            nextBestStep: expect.any(String),
          }),
          retained: expect.objectContaining({
            currentObjective: true,
            requirementsSummary: true,
            nextBestStep: true,
            specExecution: true,
          }),
        }),
      }),
    );
  });

  it("uses the seeded project spec artifact instead of re-inferring the worker objective", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-worker-seeded-spec-"));
    const diagnostics = new RecordingDiagnostics();
    const projectDir = join(dir, "clients", "client-a", "sessions", "session-1", "project");
    mkdirSync(join(projectDir, "docs"), { recursive: true });
    writeFileSync(
      join(projectDir, "docs", "spec.md"),
      `# Specification

Objective: QDM Finished Lot Yield Dashboard
Delivery mode: static_simulation

## Source Documents

- docs/Requirements Document-20260611-022831-597996.md
- docs/Design Document-20260611-022850-817700.md

## Requirements

- REQ-001 [data] Render the QDM finished lot yield dashboard with KPI cards and charts.

## Platform Limitations

- Current adapter static-preview can serve static browser assets and static build output only.

## Acceptance Criteria

- First preview must render meaningful first-screen data without persistent loading placeholders or \`--\` KPI values.

## Quality Gates

- project_task validate

## Non Goals

- Do not implement database_runtime as a claimed real runtime.
`,
    );
    writeFileSync(
      join(projectDir, "docs", "plan.md"),
      `# Implementation Plan

Objective: QDM Finished Lot Yield Dashboard
Delivery mode: static_simulation

## Plan

- Implement the QDM dashboard from the generated spec.
`,
    );
    writeFileSync(
      join(projectDir, "docs", "tasks.md"),
      `# Tasks

- [ ] Read the generated spec, plan, and task files before editing app files.
`,
    );
    const input = createWorkerInput({
      content: `Read these files fully before writing code:
1. PRD document: Requirements Document-20260611-022831-597996.md
2. System design document: Design Document-20260611-022850-817700.md`,
    });
    input.projectContext = {
      clientId: "client-a",
      sessionId: "session-1",
      title: "QDM Finished Lot Yield Dashboard",
      projectId: "project-client-a-session-1",
      projectDir,
    };
    let observedSystemPrompt = "";
    const agent = createRunAgent(input, {
      config: loadStorageConfig(dir),
      diagnostics,
      skills: { load: () => ({ name: "unused", content: "unused" }) },
      promptSkills: [],
      defaultSkills: [],
      streamFn: async (_model: Model<any>, context: Context) => {
        observedSystemPrompt = context.systemPrompt ?? "";
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = createAssistantMessage({ text: "done" });
          stream.push({ type: "start", partial: message });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "done",
            partial: message,
          });
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
    });

    await agent.prompt(input.messages.at(-1)!);

    expect(observedSystemPrompt).toContain("objective: QDM Finished Lot Yield Dashboard");
    expect(observedSystemPrompt).not.toContain("objective: 1. PRD document");
    expect(diagnostics.events).toContainEqual(
      expect.objectContaining({
        clientId: "client-a",
        sessionId: "session-1",
        traceId: "session-1",
        eventType: "model.spec_artifact",
        data: expect.objectContaining({
          objective: "QDM Finished Lot Yield Dashboard",
          sourceDocuments: [
            "docs/Requirements Document-20260611-022831-597996.md",
            "docs/Design Document-20260611-022850-817700.md",
          ],
        }),
      }),
    );
  });

  it("records worker tool diagnostics with full args and results", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-tool-diagnostics-"));
    const diagnostics = new RecordingDiagnostics();
    const input = createWorkerInput({
      content: "Inspect the project files before continuing.",
    });
    let callIndex = 0;
    const agent = createRunAgent(input, {
      config: loadStorageConfig(dir),
      diagnostics,
      skills: { load: () => ({ name: "unused", content: "unused" }) },
      promptSkills: [],
      defaultSkills: [],
      streamFn: async () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (callIndex === 0) {
            const message = createToolCallAssistantMessage(
              "tool-list",
              "project_file",
              { command: "list" },
            );
            stream.push({ type: "done", reason: "toolUse", message });
          } else {
            const message = createAssistantMessage({ text: "done" });
            stream.push({ type: "start", partial: message });
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: "done",
              partial: message,
            });
            stream.push({ type: "done", reason: "stop", message });
          }
          callIndex += 1;
        });
        return stream;
      },
    });

    await agent.prompt(input.messages.at(-1)!);

    expect(diagnostics.events).toContainEqual(
      expect.objectContaining({
        clientId: "client-a",
        sessionId: "session-1",
        traceId: "session-1",
        category: "tool",
        eventType: "agent.tool_execution_start",
        data: expect.objectContaining({
          toolCallId: "tool-list",
          toolName: "project_file",
          args: { command: "list" },
        }),
      }),
    );
    expect(diagnostics.events).toContainEqual(
      expect.objectContaining({
        clientId: "client-a",
        sessionId: "session-1",
        traceId: "session-1",
        category: "tool",
        eventType: "agent.tool_execution_end",
        data: expect.objectContaining({
          toolCallId: "tool-list",
          toolName: "project_file",
          isError: false,
          result: expect.objectContaining({
            details: expect.objectContaining({ command: "list", files: [] }),
          }),
        }),
      }),
    );
  });

  it("maps worker run event retention config into Redis bus and sink options", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-run-events-"));
    const config = {
      ...loadStorageConfig(dir),
      redisUrl: "redis://127.0.0.1:6380",
      runEventStreamMaxLen: 1234,
      runEventStreamTtlSeconds: 5678,
      runEventCheckpointIntervalMs: 90,
      runEventCheckpointMinChars: 12,
    };

    const options = createWorkerRunEventOptions(config);
    const busOptions: RedisRunEventBusOptions = options.bus;
    const sinkOptions: Pick<
      RunEventSinkOptions,
      "checkpointIntervalMs" | "checkpointMinChars"
    > = options.sink;

    expect(busOptions).toEqual({
      redisUrl: "redis://127.0.0.1:6380",
      maxLen: 1234,
      ttlSeconds: 5678,
    });
    expect(sinkOptions).toEqual({
      checkpointIntervalMs: 90,
      checkpointMinChars: 12,
    });
  });

  it("records agent v2 defaults in worker startup diagnostics", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-v2-startup-"));
    const config = {
      ...loadStorageConfig(dir),
      appAgentVersion: "v2",
      runQueueName: "legacy-runs",
      agentV2RunQueueName: "agent-v2-runs",
      agentV2RunEventStreamMaxLen: 4321,
      agentV2RunEventStreamTtlSeconds: 8765,
    } as ReturnType<typeof loadStorageConfig>;

    const events = createWorkerStartupDiagnosticEvents(config);

    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "system.startup.config",
        data: expect.objectContaining({
          appAgentVersion: "v2",
          runQueueName: "legacy-runs",
          agentV2RunQueueName: "agent-v2-runs",
          agentV2RunEventStreamMaxLen: 4321,
          agentV2RunEventStreamTtlSeconds: 8765,
        }),
      }),
    );
  });

  it("maps agent v2 worker queue and event stream config into Redis options", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-v2-events-"));
    const config = {
      ...loadStorageConfig(dir),
      redisUrl: "redis://127.0.0.1:6381",
      agentV2RunQueueName: "agent-v2-runs",
      agentV2RunEventStreamMaxLen: 2222,
      agentV2RunEventStreamTtlSeconds: 3333,
    };

    const options = createAgentV2WorkerRunEventOptions(config);
    const busOptions: RedisAgentV2RunEventBusOptions = options.bus;

    expect(options.queue).toEqual({
      redisUrl: "redis://127.0.0.1:6381",
      queueName: "agent-v2-runs",
    });
    expect(busOptions).toEqual({
      redisUrl: "redis://127.0.0.1:6381",
      maxLen: 2222,
      ttlSeconds: 3333,
    });
  });

  it("forwards the production agent v2 worker cancellation signal into execution", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-v2-cancel-"));
    const config = loadStorageConfig(dir);
    const db = new RuntimeDbStore(join(dir, "runtime.sqlite"));

    try {
      db.ensureSchema();
      db.ensureAgentV2Schema();
      const run = db.createAgentV2Run({
        clientId: "client-a",
        runId: "run-v2-cancel",
        input: { prompt: "Build an app", sessionId: "session-1", title: "Diagnostics" },
        model: { provider: "test" },
        createdAt: "2026-07-08T09:00:00.000Z",
      });
      const controller = new AbortController();
      controller.abort(new Error("worker cancellation"));

      await expect(
        createAgentV2WorkerExecution(config).executeNextTask({
          store: db,
          run,
          workerId: "worker-1",
          signal: controller.signal,
        }),
      ).rejects.toThrow("worker cancellation");
    } finally {
      db.close();
    }
  });

  it("retries production stream error final events before persisting assistant errors", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-retry-"));
    const diagnostics = new RecordingDiagnostics();
    const config = loadStorageConfig(dir);
    const db = new RuntimeDbStore(join(dir, "runtime.sqlite"));
    const queue = new InMemoryRunQueue();
    let streamAttempts = 0;

    try {
      db.ensureSchema();
      const run = createQueuedRun(db);
      await queue.enqueue({ clientId: run.clientId, runId: run.runId });

      const worker = new WorkspaceRunWorkerService({
        db,
        queue,
        workerId: "worker-1",
        diagnostics,
        retry: { sleep: async () => {} },
        createAgent(input) {
          return createRunAgent(input, {
            config,
            diagnostics,
            skills: { load: () => ({ name: "unused", content: "unused" }) },
            promptSkills: [],
            defaultSkills: [],
            streamFn: async (
              _model: Model<any>,
              _context: Context,
              _options?: SimpleStreamOptions,
            ) => {
              streamAttempts += 1;
              const stream = createAssistantMessageEventStream();
              queueMicrotask(() => {
                if (streamAttempts === 1) {
                  stream.push({
                    type: "error",
                    reason: "error",
                    error: createAssistantMessage({
                      stopReason: "error",
                      errorMessage: "503 service unavailable",
                    }),
                  });
                  return;
                }
                const message = createAssistantMessage({ text: "done" });
                stream.push({ type: "start", partial: message });
                stream.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: "done",
                  partial: message,
                });
                stream.push({ type: "done", reason: "stop", message });
              });
              return stream;
            },
          });
        },
      });

      await expect(worker.processOne()).resolves.toBe(true);

      expect(streamAttempts).toBe(2);
      expect(db.getRun(run.clientId, run.runId)?.status).toBe("completed");
      const messages = db.listMessages(run.clientId, run.sessionId);
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(JSON.stringify(messages)).not.toContain("503 service unavailable");
      expect(diagnostics.events).toContainEqual(
        expect.objectContaining({
          eventType: "agent.retry_scheduled",
          level: "warn",
          category: "agent",
          data: expect.objectContaining({
            runId: run.runId,
            reasonCode: "transient_provider_error",
          }),
        }),
      );
    } finally {
      await queue.close();
      db.close();
    }
  });

  it("keeps worker runs alive when diagnostic logging is locked", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-diagnostics-locked-"));
    const diagnostics = new LockedDiagnostics();
    const config = loadStorageConfig(dir);
    const db = new RuntimeDbStore(join(dir, "runtime.sqlite"));
    const queue = new InMemoryRunQueue();

    try {
      db.ensureSchema();
      const run = createQueuedRun(db);
      await queue.enqueue({ clientId: run.clientId, runId: run.runId });

      const worker = new WorkspaceRunWorkerService({
        db,
        queue,
        workerId: "worker-1",
        diagnostics,
        createAgent(input) {
          const model = input.model as Model<Api>;
          return createRunAgent(input, {
            config,
            diagnostics,
            skills: { load: () => ({ name: "unused", content: "unused" }) },
            promptSkills: [],
            defaultSkills: [],
            streamFn: async (
              _model: Model<Api>,
              _context: Context,
              options?: SimpleStreamOptions,
            ) => {
              await options?.onPayload?.(
                { messages: [{ role: "user", content: "hello" }] },
                model,
              );
              const stream = createAssistantMessageEventStream();
              queueMicrotask(() => {
                const message = createAssistantMessage({ text: "done" });
                stream.push({ type: "start", partial: message });
                stream.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: "done",
                  partial: message,
                });
                stream.push({ type: "done", reason: "stop", message });
              });
              return stream;
            },
          });
        },
      });

      await expect(worker.processOne()).resolves.toBe(true);

      expect(db.getRun(run.clientId, run.runId)?.status).toBe("completed");
      const messages = db.listMessages(run.clientId, run.sessionId);
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(JSON.stringify(messages)).toContain("done");
      expect(JSON.stringify(messages)).not.toContain("database is locked");
    } finally {
      await queue.close();
      db.close();
    }
  });
});

class RecordingDiagnostics {
  events: JsonObject[] = [];

  writeEvents(input: { events: JsonObject[] }): JsonObject {
    this.events.push(...input.events);
    return { accepted: input.events.length, dropped: 0 };
  }
}

class LockedDiagnostics {
  writeEvents(): JsonObject {
    throw new Error("database is locked");
  }
}

function createWorkerInput(
  overrides: { content?: string } = {},
): WorkerAgentInput {
  return {
    run: {
      runId: "run-1",
      clientId: "client-a",
      sessionId: "session-1",
      status: "running",
      model: createModel(),
      thinkingLevel: "medium",
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
    },
    session: {
      sessionId: "session-1",
      clientId: "client-a",
      title: "Diagnostics",
      model: createModel(),
      thinkingLevel: "medium",
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
    },
    messages: [
      {
        messageId: 1,
        clientId: "client-a",
        sessionId: "session-1",
        role: "user",
        payload: { content: overrides.content ?? "hello" },
        createdAt: "2026-06-11T00:00:00.000Z",
      },
    ],
    model: createModel(),
    thinkingLevel: "medium",
    signal: new AbortController().signal,
  };
}

function createQueuedRun(db: RuntimeDbStore) {
  const model = createModel();
  db.upsertClient("client-a");
  const session = db.createSession({
    clientId: "client-a",
    sessionId: "session-1",
    title: "Diagnostics",
    model,
    thinkingLevel: "medium",
  });
  db.appendMessage({
    clientId: session.clientId,
    sessionId: session.sessionId,
    role: "user",
    payload: { content: "hello" },
  });
  return db.createRun({
    clientId: session.clientId,
    sessionId: session.sessionId,
    runId: "run-1",
    model,
    thinkingLevel: "medium",
  });
}

function createModel(): Model<"openai-completions"> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "Test Provider",
    baseUrl: "http://127.0.0.1:8000/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
}

function createAssistantMessage(
  options: {
    text?: string;
    stopReason?: "stop" | "error";
    errorMessage?: string;
  } = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: options.text ?? "" }],
    api: "openai-completions",
    provider: "Test Provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options.stopReason ?? "stop",
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function createToolCallAssistantMessage(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AssistantMessage {
  return {
    ...createAssistantMessage(),
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "toolUse",
  };
}
