import { describe, expect, test } from "bun:test";
import { apply, Config, name, inject } from "./index.ts";
import { PROJECTION_KEY } from "./service.ts";
import { DEFAULT_NOTEBOOK } from "./markdown.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

describe("omd-context-notes plugin entry", () => {
  test("exports plugin metadata", () => {
    expect(name).toBe("omd-context-notes");
    expect(inject).toContain("sessionProjections");
    expect(inject).toContain("systemPrompt");
    expect(inject).toContain("sessions");
    expect(Config).toBeDefined();
  });

  test("apply registers projection, prompt section and service", async () => {
    let registeredProjection: any = null;
    let registeredSection: any = null;
    let providedService: any = null;
    const listeners = new Map<string, Array<(...args: any[]) => any>>();

    const fakeCtx = {
      provide: (key: string, value: any) => {
        if (key === "contextNotes") providedService = value;
      },
      sessionProjections: {
        register: (def: any) => {
          registeredProjection = def;
          return () => {};
        },
        stateOf: () => undefined,
      },
      systemPrompt: {
        section: (sec: any) => {
          registeredSection = sec;
          return () => {};
        },
      },
      on: (event: string, fn: (...args: any[]) => any) => {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
        return () => {};
      },
      inject: () => {},
    } as unknown as Context;

    apply(fakeCtx, { maxBytes: 16384, sectionOrder: 85 });

    expect(providedService).toBeDefined();
    expect(registeredProjection).toBeDefined();
    expect(registeredProjection.key).toBe(PROJECTION_KEY);
    expect(registeredSection).toBeDefined();
  });

  test("projection fold handles context-notes/updated and tool/result", () => {
    let registeredProjection: any = null;
    const fakeCtx = {
      provide: () => {},
      tools: { register: () => () => {} },
      sessionProjections: {
        register: (def: any) => { registeredProjection = def; return () => {}; },
        stateOf: () => undefined,
      },
      systemPrompt: { section: () => () => {} },
      on: () => () => {},
      inject: () => {},
    } as unknown as Context;

    apply(fakeCtx, { maxBytes: 16384, sectionOrder: 85 });

    const init = registeredProjection.init();
    expect(init.text).toBe(DEFAULT_NOTEBOOK);

    // Event 1: the plugin record this package writes
    const event1: SessionEvent = {
      type: "plugin:omd-context-notes/updated" as any,
      seq: 1 as any,
      time: 100,
      data: { text: "# Shared\nLive user text\n\n# Agent notes\n", bytes: 40, version: 1000 },
    };
    const state1 = registeredProjection.apply(init, event1);
    expect(state1.text).toBe(event1.data.text);
    expect(state1.version).toBe(1000);

    // Event 2: tool/result with presentationMeta
    const event2: SessionEvent = {
      type: "tool/result",
      seq: 2 as any,
      time: 200,
      data: {
        turn: 1,
        step: 1,
        message: { callId: "c1" as any, role: "tool", content: [] },
        meta: {
          contextNotes: { text: "# Shared\nTool updated\n\n# Agent notes\n", bytes: 38, version: 2000 },
        },
      } as any,
    };
    const state2 = registeredProjection.apply(state1, event2);
    expect(state2.text).toBe(event2.data.meta.contextNotes.text);
    expect(state2.version).toBe(2000);
  });
});
