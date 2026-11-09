import { describe, expect, test } from "bun:test";
import { ContextNotesServiceImpl } from "./service.ts";
import { parseNotebook } from "./markdown.ts";
import { NOTE_RECORD_TYPE } from "./record.ts";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";

/**
 * Fold one session's notebook the way the projection does: the newest record
 * wins. A real Session is used because the record writer reaches the session's
 * private commit path.
 */
function folded(session: Session): { text: string; bytes: number; version: number } {
  let state = { text: "", bytes: 0, version: 0 };
  for (const event of session.snapshotEvents()) {
    if (event.type !== NOTE_RECORD_TYPE) continue;
    const data: unknown = event.data;
    if (data === null || typeof data !== "object") continue;
    const { text, bytes, version } = data as { text?: unknown; bytes?: unknown; version?: unknown };
    if (typeof text === "string" && typeof bytes === "number" && typeof version === "number") {
      state = { text, bytes, version };
    }
  }
  return state;
}

/** Minimal fake ctx with a real session registry and a log-folding projection. */
function fakeCtx(sessionIds: string[], botSessionIds = sessionIds) {
  const sessions = new Map(sessionIds.map(id => [id, Session.create(SessionId(id))]));
  const bots = new Set(botSessionIds);
  const ctx = {
    get: (key: string) => key === 'dsBot' ? {
      rt: { selfOf: (id: string) => bots.has(id) ? id : undefined, roomOf: () => undefined, pastOwners: new Map() },
    } : undefined,
    sessions: {
      get: (id: { toString(): string }) => sessions.get(id.toString()),
    },
    sessionProjections: {
      stateOf: (session: Session, _key: string) => folded(session),
    },
  } as unknown as Context;
  return { ctx, sessions };
}

describe("ContextNotesServiceImpl", () => {
  test("pathFor returns canonical internal path", () => {
    const { ctx } = fakeCtx(["s1"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);
    expect(service.pathFor("s1")).toBe("dsh-resource://notebook/s1/notes.md");
  });

  test("allocate records ownership; dispose removes it", () => {
    const { ctx } = fakeCtx(["s1", "child-1"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);
    const allocation = service.allocate("child-1", { title: "Sub task" });
    expect(allocation.path).toBe("dsh-resource://notebook/child-1/notes.md");
    // No event appended yet (lazy init)
    const session = ctx.sessions.get("child-1");
    expect(session.snapshotEvents()).toHaveLength(0);
    allocation.dispose();
  });

  test("allocate with initialContent writes eagerly when session is live", () => {
    const { ctx } = fakeCtx(["s1", "child-1"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);
    service.allocate("child-1", { initialContent: "# Shared\nCustom\n\n# Agent notes\nEmpty" });
    const session = ctx.sessions.get("child-1");
    const events = session.snapshotEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(NOTE_RECORD_TYPE);
  });

  test("read returns default notebook for a session with no notes", () => {
    const { ctx } = fakeCtx(["s1"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);
    return service.read("s1").then((result) => {
      expect(result.version).toBe(0);
      expect(result.fullText).toContain("# Shared");
      expect(result.fullText).toContain("# Agent notes");
    });
  });

  test("saveShared writes shared text with conflict detection", async () => {
    const { ctx } = fakeCtx(["s1"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);

    // First save: expectedVersion 0 matches initial state
    const first = await service.saveShared("s1", "First user note", 0);
    expect(first.ok).toBe(true);
    expect(first.state?.version).not.toBe(0);

    // Save with the old expectedVersion 0 fails with conflict
    const stale = await service.saveShared("s1", "Conflict note", 0);
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain("Conflict");

    // Save with latest version succeeds
    const latest = await service.saveShared("s1", "Second user note", first.state!.version);
    expect(latest.ok).toBe(true);
    expect(parseNotebook(latest.state!.fullText).sharedBody.trim()).toBe("Second user note");
  });

  test("saveAgent preserves the shared section", async () => {
    const { ctx } = fakeCtx(["s1"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);

    await service.saveShared("s1", "Shared content here", 0);
    const agentWrite = await service.saveAgent("s1", "Agent private state");
    expect(agentWrite.ok).toBe(true);
    const parsed = parseNotebook(agentWrite.state!.fullText);
    expect(parsed.sharedBody.trim()).toBe("Shared content here");
    expect(parsed.agentSection).toContain("Agent private state");
  });

  test("writes over the byte limit are refused with error", async () => {
    const { ctx } = fakeCtx(["s1"]);
    const service = new ContextNotesServiceImpl(ctx, 64);
    const result = await service.saveAgent("s1", "x".repeat(200));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("maximum size");
  });

  test("read of a missing session throws", async () => {
    const { ctx } = fakeCtx(["s1"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);
    await expect(service.read("nonexistent")).rejects.toThrow("not found");
  });

  test("child section allocation under parent session and authorized write", async () => {
    const { ctx } = fakeCtx(["parent-1", "child-1"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);

    // Allocate a section of parent's notebook for child-1
    const alloc = service.allocate("child-1", {
      parentSessionId: "parent-1",
      title: "Worker 1",
      initialContent: "Initial task state",
    });
    expect(alloc.path).toBe("dsh-resource://notebook/parent-1/sections/child-1.md");

    // Initial content is present under parent's agent section
    const parentInitial = await service.read("parent-1");
    expect(parentInitial.agentText).toContain("Worker 1");
    expect(parentInitial.agentText).toContain("Initial task state");

    // Authorized child writes to its own section
    const writeRes = await service.saveChildSection("parent-1", "child-1", "Step 1 complete", "child-1");
    expect(writeRes.ok).toBe(true);

    const sectionContent = await service.readSection("parent-1", "child-1");
    expect(sectionContent).toContain("Step 1 complete");
  });

  test("unauthorized child write rejected", async () => {
    const { ctx } = fakeCtx(["parent-1", "child-1", "child-2"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);

    service.allocate("child-1", { parentSessionId: "parent-1", title: "Worker 1" });
    service.allocate("child-2", { parentSessionId: "parent-1", title: "Worker 2" });

    // child-1 tries to write to sibling child-2's section
    const siblingWrite = await service.saveChildSection("parent-1", "child-2", "Hacked!", "child-1");
    expect(siblingWrite.ok).toBe(false);
    expect(siblingWrite.error).toContain("Permission denied");

    // child-1 tries to write to parent's shared section directly
    const sharedWrite = await service.write({
      sessionId: "parent-1",
      target: "shared",
      content: "Overwriting shared",
      author: "agent",
      callerSessionId: "child-1",
    });
    expect(sharedWrite.ok).toBe(false);
    expect(sharedWrite.error).toContain("Permission denied");
  });

  test("disposal revokes child writing while retaining content for parent", async () => {
    const { ctx } = fakeCtx(["parent-1", "child-1"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);

    const alloc = service.allocate("child-1", { parentSessionId: "parent-1", title: "Worker 1" });
    await service.saveChildSection("parent-1", "child-1", "Evidence saved before exit", "child-1");

    // Child task ends and disposes allocation
    alloc.dispose();

    // Further writes by child are rejected
    const writeAfterDispose = await service.saveChildSection("parent-1", "child-1", "More text", "child-1");
    expect(writeAfterDispose.ok).toBe(false);
    expect(writeAfterDispose.error).toContain("revoked or disposed");

    // But parent still sees the retained evidence
    const parentNotes = await service.read("parent-1");
    expect(parentNotes.agentText).toContain("Evidence saved before exit");
  });

  test("model full replace cannot erase concurrent user shared edits", async () => {
    const { ctx } = fakeCtx(["s1"]);
    const service = new ContextNotesServiceImpl(ctx, 16384);

    // User creates shared note
    await service.saveShared("s1", "Important human requirements", 0);

    // Agent attempts full replace without matching expectedVersion and with altered shared section
    const badFullReplace = await service.saveFull("s1", "# Shared\nErased by model\n\n# Agent notes\nAgent notes");
    expect(badFullReplace.ok).toBe(false);
    expect(badFullReplace.error).toContain("Conflict");
  });
});
