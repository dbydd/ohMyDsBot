import { describe, expect, test } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { InternalPathsServiceImpl } from "../../../host/omd-internal-paths/src/service.ts";
import * as ContextNotes from "./index.ts";
import { parseNotebook } from "./markdown.ts";

describe("omd-context-notes Cordis integration smoke", () => {
  test("full runtime composition, internal paths, child allocation, prompt assembly and conflict", async () => {
    // 1. Root Context and services composition
    const root = new Context();
    await root.plugin(SessionProjectionRegistry);
    await root.plugin(SystemPrompt);
    const internalPaths = new InternalPathsServiceImpl();
    root.provide("internalPaths", internalPaths as any);

    // Mock sessions service
    const sessionsMap = new Map<string, Session>();
    const mockSessions = {
      get: (id: { toString(): string }) => sessionsMap.get(id.toString()),
      create: (id?: any) => {
        const sid = id || SessionId("test-session");
        const s = Session.create(sid);
        sessionsMap.set(sid.toString(), s);
        return s;
      },
    };
    root.provide("sessions", mockSessions as any);
    root.provide("dsBot", {
      rt: {
        selfOf: (id: string) => id === 'smoke-session-1' ? id : undefined,
        roomOf: () => undefined,
        pastOwners: new Map(),
      },
    });

    // 2. Mount omd-context-notes plugin into the Cordis root
    const fiber = await root.plugin(ContextNotes, { maxBytes: 16384, sectionOrder: 85 });
    expect(root.get("contextNotes")).toBeDefined();

    // 3. Create a session and an agent
    const session = mockSessions.create(SessionId("smoke-session-1"));
    const agentCtx = root.extend();
    const agent = {
      id: "agent-1",
      session,
      ctx: agentCtx,
    };

    // 4. Initial read via internalPaths
    const initialRead = await internalPaths.read("notebook://smoke-session-1/notes.md", {
      agent: agent as any,
    });
    expect(initialRead).toBeDefined();
    expect(initialRead).toContain("# Shared");
    expect(initialRead).toContain("# Agent notes");

    // 5. Update shared section via internalPaths write
    await internalPaths.write("notebook://smoke-session-1/shared.md", "User and agent agreed plan A", {
      agent: agent as any,
      origin: "model",
    });

    const readAfterWrite = await internalPaths.read("notebook://smoke-session-1/shared.md", {
      agent: agent as any,
    });
    expect(readAfterWrite).toContain("User and agent agreed plan A");

    const state1 = root.contextNotes.read("smoke-session-1");
    const v1 = (await state1).version;
    expect(v1).not.toBe(0);

    // 6. Verify projection updated
    const projState1 = root.sessionProjections.stateOf(session, "contextNotes");
    expect(projState1.version).toBe(v1);
    expect(projState1.text).toContain("User and agent agreed plan A");

    // 7. Verify prompt assembly includes the updated notebook
    const assembled = await root.systemPrompt.assemble({
      agent: agent as any,
      signal: new AbortController().signal,
    });
    const promptText = assembled.sections.map((s: any) => s.text).join("\n");
    expect(promptText).toContain("<experimental-context-notes>");
    expect(promptText).toContain("User and agent agreed plan A");

    // 8. Human API update via ctx.contextNotes.saveShared
    const service = root.contextNotes;
    const humanUpdate = await service.saveShared("smoke-session-1", "Human modified shared plan B", v1);
    expect(humanUpdate.ok).toBe(true);
    const v2 = humanUpdate.state!.version;
    expect(v2).toBeGreaterThan(v1);

    // Verify model sees the human update in next prompt assembly
    const assembled2 = await root.systemPrompt.assemble({
      agent: agent as any,
      signal: new AbortController().signal,
    });
    const promptText2 = assembled2.sections.map((s: any) => s.text).join("\n");
    expect(promptText2).toContain("Human modified shared plan B");

    // 9. Stale shared save returns conflict
    const staleSave = await service.saveShared("smoke-session-1", "Stale concurrent edit", v1);
    expect(staleSave.ok).toBe(false);
    expect(staleSave.error).toContain("Conflict");

    // 10. Child section allocation and write via internalPaths
    const alloc = root.contextNotes.allocate("child-1", {
      parentSessionId: "smoke-session-1",
      title: "Worker Subagent",
    });
    expect(alloc.path).toBe("dsh-resource://notebook/smoke-session-1/sections/child-1.md");

    // Child writes to its assigned section
    await internalPaths.write("notebook://smoke-session-1/sections/child-1.md", "Child progress step 1", {
      sessionId: "child-1",
      origin: "model",
    });

    const childSection = await internalPaths.read("notebook://smoke-session-1/sections/child-1.md", {
      sessionId: "child-1",
    });
    expect(childSection).toContain("Child progress step 1");

    // Parent notebook has both human shared and child section
    const fullParent = await internalPaths.read("notebook://smoke-session-1/notes.md", {
      agent: agent as any,
    });
    expect(fullParent).toContain("Human modified shared plan B");
    expect(fullParent).toContain("Worker Subagent");
    expect(fullParent).toContain("Child progress step 1");

    // 11. HMR Dispose cleanup
    await fiber.dispose();

    const assembledAfterDispose = await root.systemPrompt.assemble({
      agent: agent as any,
      signal: new AbortController().signal,
    });
    const promptAfter = assembledAfterDispose.sections.map((s: any) => s.text).join("\n");
    expect(promptAfter).not.toContain("<experimental-context-notes>");
  });
});
