import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./fixtures/catalog.ts";

const secret = "dev-only-secret-of-at-least-32-bytes";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const setup = async () => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "catalog-test", version: "0.1.0" });

  await Promise.all([createServer(secret).connect(st), client.connect(ct)]);
  clients.push(client);

  return client;
};

type Result = Awaited<ReturnType<Client["callTool"]>>;

const text = (result: Result): string =>
  Array.isArray(result.content)
    ? result.content.map((block) => (typeof block.text === "string" ? block.text : "")).join("\n")
    : "";

describe("catalog meta tool", () => {
  it("lists workflows and returns JSON or Mermaid graphs without a token", async () => {
    const client = await setup();
    const tools = (await client.listTools()).tools;
    const listed = tools.find((tool) => tool.name === "baton_workflows");

    expect(listed?.inputSchema.properties).toHaveProperty("workflow");
    expect(listed?.inputSchema.properties).toHaveProperty("format");
    expect(listed?.inputSchema.required ?? []).not.toContain("proof_token");

    const all = await client.callTool({ name: "baton_workflows", arguments: {} });

    expect(all.isError).not.toBe(true);
    expect(all.structuredContent).toEqual({
      workflows: [
        { name: "documents", entries: ["read_guidelines"], step_count: 2 },
        { name: "releases", entries: ["build"], step_count: 1 },
      ],
    });

    const graph = await client.callTool({
      name: "baton_workflows",
      arguments: { workflow: "documents" },
    });

    expect(graph.structuredContent).toMatchObject({
      flow: "documents",
      entries: ["read_guidelines"],
    });

    const diagram = await client.callTool({
      name: "baton_workflows",
      arguments: { workflow: "documents", format: "mermaid" },
    });

    expect(diagram.isError).not.toBe(true);
    expect(text(diagram)).toContain("n_read_guidelines -- pass --> n_save_doc");
    expect(text(diagram)).toContain("n_read_guidelines -- fail --> n_read_guidelines");

    const combined = await client.callTool({
      name: "baton_workflows",
      arguments: { format: "mermaid" },
    });

    expect(text(combined)).toContain('subgraph workflow_0["documents"]');
    expect(text(combined)).toContain('subgraph workflow_1["releases"]');
  });

  it("returns an MCP error for an unknown workflow", async () => {
    const client = await setup();
    const missing = await client.callTool({
      name: "baton_workflows",
      arguments: { workflow: "absent" },
    });

    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("unknown workflow absent");
  });
});
