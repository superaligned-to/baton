import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { baton, catalog } from "@superaligned/baton/zod";

const reply = <Data extends Record<string, unknown>>(data: Data) => ({
  structuredContent: data,
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const configure = (secret: string) => {
  const documents = baton({ name: "documents", secret, mcp: true });

  const read = documents
    .step("read_guidelines")
    .description("Read the guidelines.")
    .schema({})
    .func(() => reply({ passed: true }));

  const save = documents
    .step("save_doc")
    .dependsOn(read)
    .description("Save the draft.")
    .schema({})
    .func(() => reply({ saved: true }));

  read.branch({ when: (result) => result.structuredContent.passed, pass: save, fail: read });

  const releases = baton({ name: "releases", secret, mcp: true });

  releases
    .step("build")
    .description("Build the package.")
    .schema({})
    .func(() => reply({ built: true }));

  const workflows = catalog([documents, releases]);
  const tool = workflows.tool();
  const server = new McpServer({ name: "catalog", version: "0.1.0" });

  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.schema },
    tool.func,
  );

  return server;
};

export const createServer = (secret = process.env.BATON_SECRET ?? ""): McpServer =>
  configure(secret);
