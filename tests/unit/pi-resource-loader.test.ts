import { describe, expect, it } from "vitest";
import { createEmptyResourceLoader } from "../../src/server/adapters/pi/resource-loader.js";

describe("Pi resource isolation", () => {
  it("provides only the application prompt and ignores added resource paths", async () => {
    const loader = createEmptyResourceLoader("Application-owned prompt");
    loader.extendResources({ skillPaths: [{ path: "/untrusted", metadata: { source: "untrusted", scope: "project", origin: "top-level" } }] });
    await loader.reload();
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getSystemPrompt()).toBe("Application-owned prompt");
    expect(loader.getSystemPromptSource()).toBeUndefined();
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAppendSystemPromptSources()).toEqual([]);
  });
});
