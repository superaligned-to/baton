import { describe, expect, it } from "vitest";
import { catalog, type WorkflowSource } from "./catalog.ts";
import { baton } from "./index.ts";
import { catalog as zodCatalog } from "./zod.ts";

const secret = "dev-only-secret-of-at-least-32-bytes";

const buildFlows = () => {
  const publish = baton({ name: "publish-document", secret });

  const read = publish
    .step("read")
    .description("Read a document.")
    .func(({ doc }: { doc: string }) => ({ doc, passed: true }));

  const check = publish
    .step("check", { from: { doc: read.output((result) => result.doc) } })
    .description("Check the document.")
    .func(({ doc }: { doc: string }) => ({ doc, passed: true }));

  const save = publish
    .step("save", { from: { doc: check.output((result) => result.doc) } })
    .description("Save the document.")
    .func(({ doc }: { doc: string }) => ({ doc, saved: true }));

  check.branch({
    when: (result) => result.passed,
    pass: save,
    fail: read,
  });

  const release = baton({ name: "release", secret });

  release
    .step("build")
    .description("Build the package.")
    .func(() => ({ built: true }));

  return { publish, release };
};

describe("workflow catalog", () => {
  it("lists every workflow and reads one graph without a proof token", () => {
    const flows = buildFlows();
    const workflows = catalog([flows.publish, flows.release]);

    expect(workflows.name).toBe("baton_workflows");
    expect(workflows.list()).toEqual({
      workflows: [
        { name: "publish-document", entries: ["read"], step_count: 3 },
        { name: "release", entries: ["build"], step_count: 1 },
      ],
    });

    const graph = workflows.graph("publish-document");

    expect(flows.publish.name).toBe("publish-document");
    expect(flows.publish.graph()).toEqual(graph);
    expect(graph.entries).toEqual(["read"]);
    expect(graph.steps.map((step) => step.tool)).toEqual(["read", "check", "save"]);
    expect(graph.steps[1]).toMatchObject({
      tool: "check",
      dependencies: ["read"],
      next: ["save", "read"],
      branch: { pass: "save", fail: "read" },
    });
    expect(graph.steps[0]?.branch).toBeNull();
  });

  it("renders JSON and Mermaid representations", () => {
    const flows = buildFlows();
    const workflows = catalog([flows.publish, flows.release], { name: "baton_docs_workflows" });

    expect(workflows.name).toBe("baton_docs_workflows");
    expect(workflows.describe()).toEqual(workflows.list());
    expect(workflows.describe({ workflow: "release" })).toMatchObject({ flow: "release" });

    expect(workflows.describe({ workflow: "publish-document", format: "mermaid" })).toBe(
      [
        "flowchart LR",
        '  n_read(["read"])',
        '  n_check{"check"}',
        '  n_save["save"]',
        "",
        "  n_read --> n_check",
        "  n_check -- pass --> n_save",
        "  n_check -- fail --> n_read",
      ].join("\n"),
    );

    const combined = workflows.describe({ format: "mermaid" });

    expect(combined).toContain("flowchart LR");
    expect(combined).toContain('subgraph workflow_0["publish-document"]');
    expect(combined).toContain('subgraph workflow_1["release"]');
    expect(combined).toContain('    workflow_1_build(["build"])');
    expect(combined).toContain("  end");
    expect(workflows.describe({ workflow: "release", format: "mermaid" })).toBe(
      ["flowchart LR", '  n_build(["build"])'].join("\n"),
    );
  });

  it("returns text and structured content from the MCP tool", async () => {
    const flows = buildFlows();
    const tool = catalog([flows.publish, flows.release]).tool();

    expect(tool.name).toBe("baton_workflows");
    expect(tool.inputSchema.properties.format.enum).toEqual(["json", "mermaid"]);
    expect(tool.description).toContain("no proof_token");

    const listed = await tool.func({});

    expect(listed.isError).toBeUndefined();
    expect(JSON.parse(listed.content[0]?.text ?? "")).toMatchObject({
      workflows: [{ name: "publish-document" }, { name: "release" }],
    });
    expect(listed.structuredContent).toMatchObject({ workflows: expect.any(Array) });

    const diagram = await tool.func({ workflow: "publish-document", format: "mermaid" });

    expect(diagram.structuredContent).toBeUndefined();
    expect(diagram.content[0]?.text).toContain("flowchart LR");

    const graph = await tool.func({ workflow: "release", format: "json" });

    expect(JSON.parse(graph.content[0]?.text ?? "")).toMatchObject({ flow: "release" });

    const missing = await tool.func({ workflow: "absent" });

    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("unknown workflow absent");
  });

  it("exposes a Zod schema for the MCP SDK", async () => {
    const flows = buildFlows();
    const workflows = zodCatalog([flows.publish, flows.release]);
    const tool = workflows.tool();

    expect(tool.name).toBe("baton_workflows");
    expect(tool.schema.workflow.unwrap().safeParse("publish-document").success).toBe(true);
    expect(tool.schema.format.unwrap().safeParse("mermaid").success).toBe(true);
    expect(tool.schema.format.unwrap().safeParse("yaml").success).toBe(false);

    const diagram = await tool.func({ workflow: "publish-document", format: "mermaid" });

    expect(diagram.content[0]?.text).toContain("flowchart LR");
    expect(workflows.graph("release")).toMatchObject({ flow: "release" });
  });

  it("refuses invalid configuration and arguments", async () => {
    const flows = buildFlows();

    expect(() => catalog([])).toThrow(/at least one workflow/);
    expect(() => catalog([flows.release], { name: "not a tool" })).toThrow(/catalog names/);
    expect(() => catalog([flows.release, flows.release])).toThrow(/already in this catalog/);

    const workflows = catalog([flows.release]);

    expect(() => workflows.graph("absent")).toThrow(/unknown workflow absent/);
    expect(() => workflows.describe({ workflow: "absent" })).toThrow(/unknown workflow absent/);
    expect(() => workflows.describe({ format: "yaml" as never })).toThrow(/json or mermaid/);

    const invalid = await workflows.tool().func({ format: "yaml" as never });

    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toContain("format must be json or mermaid");

    const broken: WorkflowSource = {
      name: "broken",
      graph: () => {
        throw new Error("graph failed");
      },
    };

    await expect(catalog([broken]).tool().func({})).rejects.toThrow("graph failed");
  });
});
