import { describe, expect, test } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as AgentsPlugin from "./index.ts";

describe("omd-agents catalog and capability routing", () => {
  test("mounts built-in capability tiers when no agents configured", async () => {
    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(AgentsPlugin, { sectionOrder: 80 });

    const catalog = root.agentCatalog;
    expect(catalog).toBeDefined();

    const list = catalog.list();
    expect(list.length).toBeGreaterThanOrEqual(4);

    const engineer = catalog.resolve("engineer");
    expect(engineer).toBeDefined();
    expect(engineer?.model).toBe("magpie/group/engineer");
    expect(engineer?.tools).toContain("bash");
    expect(engineer?.tools).toContain("edit");

    const labor = catalog.resolve("labor");
    expect(labor).toBeDefined();
    expect(labor?.model).toBe("magpie/group/labor");

    const philosopher = catalog.resolve("philosopher");
    expect(philosopher).toBeDefined();
    expect(philosopher?.model).toBe("magpie/group/philosopher");

    const theorist = catalog.resolve("theorist");
    expect(theorist).toBeDefined();
    expect(theorist?.model).toBe("magpie/group/theorist");
  });

  test("config routes override or add custom agents", async () => {
    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(AgentsPlugin, {
      sectionOrder: 80,
      agents: {
        customWorker: {
          description: "Custom test worker",
          model: "custom-provider/worker-model",
          tools: ["read", "write"],
        },
        engineer: {
          description: "Overridden engineer tier",
          model: "custom-provider/engineer-fast",
        },
      },
    });

    const catalog = root.agentCatalog;
    expect(catalog.resolve("customWorker")?.model).toBe("custom-provider/worker-model");
    expect(catalog.resolve("engineer")?.model).toBe("custom-provider/engineer-fast");
    expect(catalog.resolve("labor")?.model).toBe("magpie/group/labor");
  });
});
