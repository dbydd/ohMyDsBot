import { describe, expect, test, mock } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { NOTE_RECORD_TYPE } from "../../omd-context-notes/src/record.ts";
import { ContextNotesServiceImpl } from "../../omd-context-notes/src/service.ts";
import * as TaskPlugin from "./index.ts";
import type { AgentCatalog, AgentDefinition } from "./types.ts";

describe("omd-task delegation and notebook scoping", () => {
  test("notebook: true allocates child section without allocating worktree checkout", async () => {
    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime);

    // Mock session and notes service
    const sessions = new Map<string, Session>();
    const parentSession = Session.create(SessionId("parent-session"));
    sessions.set("parent-session", parentSession);

    const mockSessions = {
      get: (id: any) => sessions.get(String(id)),
      create: (id?: any) => {
        const sid = id || SessionId("child-session");
        const s = Session.create(sid);
        sessions.set(sid.toString(), s);
        return s;
      },
    };
    root.provide("sessions", mockSessions as any);

    root.provide("sessionProjections", {
      stateOf: (session: Session) => {
        let state = { text: "", bytes: 0, version: 0 };
        for (const event of session.snapshotEvents()) {
          if (event.type !== NOTE_RECORD_TYPE) continue;
          const data: unknown = event.data;
          if (data && typeof data === "object") {
            const d = data as { text?: unknown; bytes?: unknown; version?: unknown };
            if (typeof d.text === "string" && typeof d.bytes === "number" && typeof d.version === "number") {
              state = { text: d.text, bytes: d.bytes, version: d.version };
            }
          }
        }
        return state.text ? state : undefined;
      },
    } as any);

    const notesService = new ContextNotesServiceImpl(root, 16384);
    root.provide("contextNotes", notesService as any);

    // Mock worktree allocator - verify it is NOT called when isolated is false
    const allocateMock = mock(() => Promise.reject(new Error("allocator should not be called!")));
    root.provide("worktreeAlloc", {
      allocate: allocateMock,
      apply: async () => ({ outcome: "applied", conflicts: [] }),
      release: async () => {},
    } as any);

    // Mock catalog
    const catalog: AgentCatalog = {
      list: () => [],
      resolve: (name: string) => ({
        name,
        description: "Test engineer",
        instructions: "Do coding",
        model: "magpie/group/engineer",
        tools: ["read", "write", "edit", "bash"],
        source: "config" as const,
      }),
    };
    root.provide("agentCatalog", catalog);

    // Mock subagents runtime
    let capturedRequest: any = null;
    let startedChildId: string | undefined;

    const mockSubagents = {
      list: () => ["spawn"],
      getProvider: (name: string) => ({
        name,
        capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
        inheritsParentContext: false,
      }),
      resolveMaxDepth: () => undefined,
      startActivation: async (spec: any) => {
        capturedRequest = spec.request;
        startedChildId = spec.childId ? String(spec.childId) : "spawned-child";
        return {
          childId: spec.childId || SessionId("spawned-child"),
          result: Promise.resolve({
            output: [{ type: "text", text: "Task completed successfully" }],
            stopReason: "completed",
          }),
          dispose: async () => {},
        };
      },
    };
    root.provide("subagents", mockSubagents as any);

    // Mount task plugin
    await root.plugin(TaskPlugin, {
      provider: "spawn",
      toolName: "task",
      maxConcurrency: 2,
      maxActiveSubagents: 4,
      retryDelayMs: 50,
      queueTimeoutMs: 5000,
      maxDepth: "provider-managed",
    } as any);

    const toolRuntime = root.get("tools") as ToolRuntime;
    const taskTool = toolRuntime.get("task");
    expect(taskTool).toBeDefined();

    const parentAgent = {
      id: "parent-agent",
      session: parentSession,
      ctx: root.extend(),
    };

    // Execute task with notebook: true, isolated: false
    const execution = await toolRuntime.execute({
      name: "task",
      arguments: {
        context: "Build the auth service",
        tasks: [
          {
            name: "WorkerOne",
            agent: "engineer",
            task: "Write auth handler",
            isolated: false,
            notebook: true,
          },
        ],
      },
      agent: parentAgent as any,
      callId: "call-1" as any,
      signal: new AbortController().signal,
    } as any);

    expect(execution.isError).toBe(false);
    expect(allocateMock).not.toHaveBeenCalled();

    // Verify prompt delivered assigned notebook section
    const promptText = capturedRequest.prompt[0].text;
    expect(promptText).toContain("Your assigned notebook section is");
    expect(promptText).toContain(`dsh-resource://notebook/parent-session/sections/${startedChildId}.md`);
    expect(promptText).toContain("Allowed tools (advisory): `read`, `write`, `edit`, `bash`");
    expect(capturedRequest.agentOptions?.model).toBe("group/engineer");
    expect(capturedRequest.agentOptions?.provider).toBe("magpie");

    // Verify parent's notebook has the child's section
    const parentNotes = await notesService.read("parent-session");
    expect(parentNotes.agentText).toContain("WorkerOne");
  });

  test("batch of two subagents concurrently write through registry to their assigned sections", async () => {
    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime);

    const sessions = new Map<string, Session>();
    const parentSession = Session.create(SessionId("parent-session-2"));
    sessions.set("parent-session-2", parentSession);

    root.provide("sessions", {
      get: (id: any) => sessions.get(String(id)),
      create: (id?: any) => {
        const sid = id || SessionId("child-session");
        const s = Session.create(sid);
        sessions.set(sid.toString(), s);
        return s;
      },
    } as any);

    root.provide("sessionProjections", {
      stateOf: (session: Session) => {
        let state = { text: "", bytes: 0, version: 0 };
        for (const event of session.snapshotEvents()) {
          if (event.type !== NOTE_RECORD_TYPE) continue;
          const data = event.data as any;
          if (data && typeof data.text === "string") {
            state = { text: data.text, bytes: data.bytes, version: data.version };
          }
        }
        return state.text ? state : undefined;
      },
    } as any);

    const notesService = new ContextNotesServiceImpl(root, 16384);
    root.provide("contextNotes", notesService as any);

    root.provide("subagents", {
      list: () => ["spawn"],
      getProvider: (name: string) => ({
        name,
        capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
        inheritsParentContext: false,
      }),
      resolveMaxDepth: () => undefined,
      startActivation: async (spec: any) => {
        const childId = String(spec.childId);
        await notesService.saveChildSection("parent-session-2", childId, `${spec.label} finished part`, childId);
        return {
          childId: spec.childId,
          result: Promise.resolve({ output: [{ type: "text", text: `Done ${spec.label}` }], stopReason: "completed" }),
          dispose: async () => {},
        };
      },
    } as any);

    await root.plugin(TaskPlugin, { provider: "spawn", toolName: "task", maxConcurrency: 2, maxActiveSubagents: 4, retryDelayMs: 50, queueTimeoutMs: 5000, maxDepth: "provider-managed" } as any);

    const toolRuntime = root.get("tools") as ToolRuntime;
    const parentAgent = { id: "p1", session: parentSession, ctx: root.extend() };

    const execution = await toolRuntime.execute({
      name: "task",
      arguments: { context: "Distributed task", tasks: [{ name: "TaskA", agent: "engineer", task: "Step A", notebook: true }, { name: "TaskB", agent: "labor", task: "Step B", notebook: true }] },
      agent: parentAgent as any,
      callId: "call-2" as any,
      signal: new AbortController().signal,
    } as any);

    expect(execution.isError).toBe(false);
    const parentNotes = await notesService.read("parent-session-2");
    expect(parentNotes.agentText).toContain("TaskA finished part");
    expect(parentNotes.agentText).toContain("TaskB finished part");
  });
});
