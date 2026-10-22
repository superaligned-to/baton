import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { baton } from "../src/zod.ts";

const secret = "dev-only-secret-of-at-least-32-bytes";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const reply = <T extends Record<string, unknown>>(value: T) => ({
  structuredContent: value,
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

type Result = Awaited<ReturnType<Client["callTool"]>>;

const messages = (result: Result): string => {
  if (!Array.isArray(result.content)) {
    throw new Error("Expected MCP content");
  }

  return result.content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
};

const token = (result: Result): string => {
  const found = messages(result).match(/proof_token: (\S+)/)?.[1];

  if (found === undefined) {
    throw new Error(messages(result));
  }

  return found;
};

const connect = async (server: McpServer): Promise<Client> => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.1.0" });

  await Promise.all([server.connect(st), client.connect(ct)]);
  clients.push(client);

  return client;
};

const setup = async (namespace?: string) => {
  const flow = baton({
    name: "parallel",
    secret,
    mcp: true,
    ...(namespace === undefined ? {} : { namespace }),
  });

  const begin = flow
    .step("begin")
    .description("Start a run")
    .schema({ artifact: z.string() })
    .func(({ artifact }) => reply({ artifact }));

  const tests = flow
    .step("test", {
      from: { artifact: begin.output((result) => result.structuredContent.artifact) },
    })
    .description("Test the artifact")
    .schema({ artifact: z.string() })
    .func(({ artifact }) => reply({ artifact, passed: true }));

  const review = flow
    .step("review", {
      from: { artifact: begin.output((result) => result.structuredContent.artifact) },
    })
    .description("Review the artifact")
    .schema({ artifact: z.string() })
    .func(({ artifact }) => reply({ artifact, approved: true }));

  const deploy = flow
    .step("deploy", {
      locked: true,
      from: {
        artifact: tests.output((result) => result.structuredContent.artifact),
      },
    })
    .dependsOn(review)
    .description("Deploy after tests and review")
    .schema({ artifact: z.string() })
    .func(({ artifact }) => reply({ artifact, deployed: true }));

  const server = new McpServer({ name: "parallel", version: "0.1.0" });

  server.registerTool(
    begin.name,
    { description: begin.description, inputSchema: begin.schema },
    begin.func,
  );
  server.registerTool(
    tests.name,
    { description: tests.description, inputSchema: tests.schema },
    tests.func,
  );
  server.registerTool(
    review.name,
    { description: review.description, inputSchema: review.schema },
    review.func,
  );
  server.registerTool(
    deploy.name,
    { description: deploy.description, inputSchema: deploy.schema },
    deploy.func,
  );

  for (const tool of flow.metaTools()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      tool.func,
    );
  }

  return connect(server);
};

describe("MCP wrapper", () => {
  it("injects its token field while preserving the application's schemas", async () => {
    const client = await setup();
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "begin",
      "test",
      "review",
      "deploy",
      "baton_status",
      "baton_list",
      "baton_refresh",
    ]);

    const tool = listed.tools.find((item) => item.name === "deploy");

    expect(tool?.inputSchema.properties).toHaveProperty("proof_token");
    expect(tool?.inputSchema.required).toEqual(["artifact"]);
    expect(tool?.description).toContain("test and review");
  });

  it("lets the wrapper explain missing tokens before running the handler", async () => {
    const client = await setup();
    const refused = await client.callTool({ name: "deploy", arguments: { artifact: "a" } });

    expect(refused.isError).toBe(true);
    expect(messages(refused)).toMatch(/^token_required:.*begin/);

    const malformed = await client.callTool({
      name: "deploy",
      arguments: { artifact: "a", proof_token: "bad" },
    });

    expect(messages(malformed)).toMatch(/^token_invalid:/);
  });

  it("joins two independent proofs from the same run", async () => {
    const client = await setup();
    const started = await client.callTool({ name: "begin", arguments: { artifact: "a" } });

    expect(messages(started)).toContain("Next:");

    const tested = await client.callTool({
      name: "test",
      arguments: { artifact: "a", proof_token: token(started) },
    });

    const reviewed = await client.callTool({
      name: "review",
      arguments: { artifact: "a", proof_token: token(started) },
    });

    const missing = await client.callTool({
      name: "deploy",
      arguments: { artifact: "a", proof_token: token(tested) },
    });

    expect(messages(missing)).toMatch(/^dependency_required:/);

    const deployed = await client.callTool({
      name: "deploy",
      arguments: {
        artifact: "a",
        proof_token: [token(tested), token(reviewed)],
      },
    });

    expect(deployed.isError).not.toBe(true);
    expect(deployed.structuredContent).toEqual({ artifact: "a", deployed: true });
    expect(messages(deployed)).toContain("This flow is finished.");

    const inspected = await client.callTool({
      name: "baton_status",
      arguments: { proof_token: token(deployed) },
    });

    expect(inspected.structuredContent).toMatchObject({
      completed: ["begin", "test", "review", "deploy"],
      next: [],
    });
  });

  it("rejects joining different runs and rejects changed linked inputs", async () => {
    const client = await setup();
    const first = await client.callTool({ name: "begin", arguments: { artifact: "a" } });
    const second = await client.callTool({ name: "begin", arguments: { artifact: "a" } });

    const tested = await client.callTool({
      name: "test",
      arguments: { artifact: "a", proof_token: token(first) },
    });

    const reviewed = await client.callTool({
      name: "review",
      arguments: { artifact: "a", proof_token: token(second) },
    });

    const mixed = await client.callTool({
      name: "deploy",
      arguments: {
        artifact: "a",
        proof_token: [token(tested), token(reviewed)],
      },
    });

    expect(messages(mixed)).toMatch(/^dependency_conflict:/);

    const sameRun = await client.callTool({
      name: "review",
      arguments: { artifact: "a", proof_token: token(tested) },
    });

    const changed = await client.callTool({
      name: "deploy",
      arguments: { artifact: "b", proof_token: token(sameRun) },
    });

    expect(messages(changed)).toMatch(/^input_mismatch:/);
  });

  it("gates all meta tools and can namespace them without losing baton_", async () => {
    const client = await setup("deploy");
    const list = await client.listTools();

    expect(list.tools.map((tool) => tool.name)).toContain("baton_deploy_status");

    for (const name of ["baton_deploy_status", "baton_deploy_list", "baton_deploy_refresh"]) {
      const refused = await client.callTool({ name, arguments: {} });

      expect(messages(refused)).toMatch(/^token_required:/);
    }

    const begin = await client.callTool({ name: "begin", arguments: { artifact: "a" } });

    const graph = await client.callTool({
      name: "baton_deploy_list",
      arguments: { proof_token: token(begin) },
    });

    expect(graph.structuredContent).toMatchObject({ flow: "parallel", entries: ["begin"] });

    const refreshed = await client.callTool({
      name: "baton_deploy_refresh",
      arguments: { proof_token: token(begin) },
    });

    const data = refreshed.structuredContent;

    expect(
      data !== null && typeof data === "object" && "proof_token" in data
        ? data.proof_token
        : undefined,
    ).toMatch(/^bt1\./);
  });
});

describe("linked schema normalization", () => {
  it("refuses changed parsed values and accepts an already normalized producer value", async () => {
    const flow = baton({ name: "normalize", secret, mcp: true });

    const source = flow
      .step("source")
      .description("Choose an identifier")
      .schema({ id: z.string() })
      .func(({ id }) => reply({ id }));

    let calls = 0;

    const target = flow
      .step("target", {
        from: { id: source.output((result) => result.structuredContent.id) },
      })
      .description("Use the exact normalized identifier")
      .schema({ id: z.string().trim() })
      .func(({ id }) => {
        calls++;

        return reply({ id });
      });

    const server = new McpServer({ name: "normalize", version: "0.1.0" });

    server.registerTool(
      source.name,
      { description: source.description, inputSchema: source.schema },
      source.func,
    );
    server.registerTool(
      target.name,
      { description: target.description, inputSchema: target.schema },
      target.func,
    );

    const client = await connect(server);
    const unnormalized = await client.callTool({ name: "source", arguments: { id: " A " } });

    const refused = await client.callTool({
      name: "target",
      arguments: { id: " A ", proof_token: token(unnormalized) },
    });

    expect(messages(refused)).toMatch(/^input_mismatch:/);
    expect(calls).toBe(0);

    const normalized = await client.callTool({ name: "source", arguments: { id: "A" } });

    const accepted = await client.callTool({
      name: "target",
      arguments: { id: "A", proof_token: token(normalized) },
    });

    expect(accepted.structuredContent).toEqual({ id: "A" });
    expect(calls).toBe(1);
  });
});
