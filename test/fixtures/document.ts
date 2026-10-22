import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { baton } from "@superaligned/baton/zod";
import { z } from "zod";

const reply = <Data extends Record<string, unknown>>(data: Data) => ({
  structuredContent: data,
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const configureTools = (secret: string) => {
  const guidelines = ["Start with a Markdown heading.", "Write at least eight words."];
  const drafts = new Map<string, string>();
  const published = new Map<string, string>();
  const flow = baton({ name: "doc-writing", secret, mcp: true });

  const read = flow
    .step("read_guidelines")
    .description("Read the document guidelines before drafting.")
    .schema({})
    .func(() => reply({ guidelines }));

  const save = flow
    .step("save_doc", { locked: true, ttl: 300 })
    .dependsOn(read)
    .description("Save a draft for checking.")
    .schema({ doc: z.string(), text: z.string() })
    .func(({ doc, text }) => {
      drafts.set(doc, text);

      return reply({ doc, text });
    });

  const check = flow
    .step("check_doc", {
      locked: true,
      from: {
        doc: save.output((result) => result.structuredContent.doc),
        text: save.output((result) => result.structuredContent.text),
      },
    })
    .description("Check the exact saved draft against the guidelines.")
    .schema({ doc: z.string(), text: z.string() })
    .func(({ doc, text }) => {
      if (drafts.get(doc) !== text) {
        throw new Error("The saved draft changed. Save and check it again.");
      }

      const problems: string[] = [];

      if (!text.startsWith("# ")) {
        problems.push("Start with a Markdown heading.");
      }

      if (text.trim().split(/\s+/).length < 8) {
        problems.push("Write at least eight words.");
      }

      return reply({ doc, text, passed: problems.length === 0, problems });
    });

  const publish = flow
    .step("publish_doc", {
      locked: true,
      from: {
        doc: check.output((result) => result.structuredContent.doc),
        text: check.output((result) => result.structuredContent.text),
      },
    })
    .description("Publish the exact draft that passed its checks.")
    .schema({ doc: z.string(), text: z.string() })
    .func(({ doc, text }) => {
      if (drafts.get(doc) !== text) {
        throw new Error("The saved draft changed. Save and check it again.");
      }

      if (published.get(doc) === text) {
        throw new Error("This draft is already published.");
      }

      published.set(doc, text);

      return reply({ doc, published: true });
    });

  check.branch({
    when: (result) => result.structuredContent.passed,
    pass: publish,
    fail: save,
  });

  const getDoc = ({ doc }: { doc: string }) =>
    reply({
      doc,
      text: drafts.get(doc) ?? published.get(doc) ?? null,
      published: published.get(doc) === drafts.get(doc) && published.has(doc),
    });

  return { flow, read, save, check, publish, getDoc };
};

export const createTools = (
  secret = process.env.BATON_SECRET ?? "",
): ReturnType<typeof configureTools> => configureTools(secret);

export const createServer = (secret = process.env.BATON_SECRET ?? ""): McpServer => {
  const { flow, read, save, check, publish, getDoc } = createTools(secret);
  const server = new McpServer({ name: "document-tools", version: "0.1.0" });

  server.registerTool(
    "get_doc",
    {
      description: "Read the current draft or published document.",
      inputSchema: { doc: z.string() },
    },
    getDoc,
  );
  server.registerTool(
    read.name,
    { description: read.description, inputSchema: read.schema },
    read.func,
  );
  server.registerTool(
    save.name,
    { description: save.description, inputSchema: save.schema },
    save.func,
  );
  server.registerTool(
    check.name,
    { description: check.description, inputSchema: check.schema },
    check.func,
  );
  server.registerTool(
    publish.name,
    { description: publish.description, inputSchema: publish.schema },
    publish.func,
  );

  for (const tool of flow.metaTools()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      tool.func,
    );
  }

  return server;
};
