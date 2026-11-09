import { describe, expect, test } from "bun:test";
import {
  parseNotebook,
  updateSharedSection,
  updateAgentSection,
  updateChildSection,
  getChildSection,
  DEFAULT_NOTEBOOK,
} from "./markdown.ts";

describe("omd-context-notes markdown parser", () => {
  test("default empty document", () => {
    const parsed = parseNotebook("");
    expect(parsed.sharedHeading).toBe("# Shared");
    expect(parsed.sharedSection.trim()).toBe("# Shared");
    expect(parsed.agentSection.trim()).toBe("# Agent notes");
    expect(parsed.structured).toBe(false);
  });

  test("two standard sections", () => {
    const doc = "# Shared\nUser note 1\n\n# Agent notes\nAgent private memory";
    const parsed = parseNotebook(doc);
    expect(parsed.structured).toBe(true);
    expect(parsed.sharedHeading).toBe("# Shared");
    expect(parsed.sharedBody.trim()).toBe("User note 1");
    expect(parsed.sharedSection.trim()).toBe("# Shared\nUser note 1");
    expect(parsed.agentSection.trim()).toBe("# Agent notes\nAgent private memory");
  });

  test("ignores level-one headings inside fenced code blocks", () => {
    const doc = `# Shared
User shared plan:
\`\`\`markdown
# Not a real heading
Some code
\`\`\`
Still shared.

~~~
# Also in tilde fence
~~~

# Agent notes
Only agent notes here!
\`\`\`
# Fenced in agent
\`\`\`
`;
    const parsed = parseNotebook(doc);
    expect(parsed.structured).toBe(true);
    expect(parsed.sharedHeading).toBe("# Shared");
    expect(parsed.sharedSection).toContain("# Not a real heading");
    expect(parsed.sharedSection).toContain("# Also in tilde fence");
    expect(parsed.sharedSection).toContain("Still shared.");
    expect(parsed.agentSection).toContain("Only agent notes here!");
    expect(parsed.agentSection).toContain("# Fenced in agent");
  });

  test("safe migration for unstructured existing data", () => {
    const legacy = "Existing unstructured context note line 1\nLine 2 with details.";
    const parsed = parseNotebook(legacy);
    expect(parsed.structured).toBe(false);
    expect(parsed.sharedHeading).toBe("# Shared");
    expect(parsed.agentSection).toContain(legacy);
    expect(parsed.agentSection).toContain("# Agent notes");
  });

  test("updateSharedSection preserves agent section", () => {
    const doc = "# Shared\nOld shared\n\n# Agent notes\nSecret agent facts";
    const updated = updateSharedSection(doc, "New shared content");
    const parsed = parseNotebook(updated);
    expect(parsed.sharedBody.trim()).toBe("New shared content");
    expect(parsed.agentSection.trim()).toBe("# Agent notes\nSecret agent facts");
  });

  test("updateSharedSection accepts heading in replacement", () => {
    const doc = "# Shared\nOld shared\n\n# Agent notes\nSecret agent facts";
    const updated = updateSharedSection(doc, "# Shared Area\nBrand new shared text");
    const parsed = parseNotebook(updated);
    expect(parsed.sharedHeading).toBe("# Shared Area");
    expect(parsed.sharedBody.trim()).toBe("Brand new shared text");
    expect(parsed.agentSection.trim()).toBe("# Agent notes\nSecret agent facts");
  });

  test("updateAgentSection preserves shared section", () => {
    const doc = "# Shared\nShared plan\n\n# Agent notes\nOld agent note";
    const updated = updateAgentSection(doc, "New agent private state");
    const parsed = parseNotebook(updated);
    expect(parsed.sharedSection.trim()).toBe("# Shared\nShared plan");
    expect(parsed.agentSection.trim()).toBe("# Agent notes\n\nNew agent private state");
  });

  test("updateChildSection appends new child subsection under # Agent notes", () => {
    const doc = "# Shared\nShared notes\n\n# Agent notes\nParent notes";
    const updated = updateChildSection(doc, "child-1", "Worker 1", "Child 1 progress details");
    const section = getChildSection(updated, "child-1");
    expect(section).toContain("Worker 1");
    expect(section).toContain("Child 1 progress details");

    const parsed = parseNotebook(updated);
    expect(parsed.sharedSection.trim()).toBe("# Shared\nShared notes");
    expect(parsed.agentSection).toContain("Parent notes");
    expect(parsed.agentSection).toContain("Worker 1");
  });

  test("updateChildSection preserves sibling sections and parent scratchpad", () => {
    const initial = updateChildSection(
      "# Shared\nShared info\n\n# Agent notes\nParent notes",
      "child-1",
      "Worker 1",
      "Child 1 note",
    );
    const withTwo = updateChildSection(initial, "child-2", "Worker 2", "Child 2 note");

    expect(getChildSection(withTwo, "child-1")).toContain("Child 1 note");
    expect(getChildSection(withTwo, "child-2")).toContain("Child 2 note");

    // Now update child-1 in place
    const updated1 = updateChildSection(withTwo, "child-1", "Worker 1", "Child 1 updated state");
    expect(getChildSection(updated1, "child-1")).toContain("Child 1 updated state");
    expect(getChildSection(updated1, "child-2")).toContain("Child 2 note");

    const parsed = parseNotebook(updated1);
    expect(parsed.sharedSection.trim()).toBe("# Shared\nShared info");
    expect(parsed.agentSection).toContain("Parent notes");
  });

  test("child section parsing ignores headings inside code fences", () => {
    const contentWithFences = "Code example:\n```markdown\n## Fake heading\n<!-- section:child-99 -->\n```\nDone.";
    const doc = updateChildSection(
      "# Shared\nShared\n\n# Agent notes\nScratchpad",
      "child-1",
      "Worker 1",
      contentWithFences,
    );
    expect(getChildSection(doc, "child-99")).toBeUndefined();
    expect(getChildSection(doc, "child-1")).toContain("## Fake heading");
    expect(getChildSection(doc, "child-1")).toContain("Done.");
  });
});
