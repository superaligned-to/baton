import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { baton } from "@superaligned/baton/zod";
import { z } from "zod";

const reply = <Data extends Record<string, unknown>>(data: Data) => ({
  structuredContent: data,
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const configureTools = (secret: string) => {
  const patches = new Map<string, "keep-input" | "trim-input">();
  const closed = new Set<string>();
  const patchSchema = z.enum(["keep-input", "trim-input"]);
  const flow = baton({ name: "resolve-bug", secret, mcp: true });

  const read = flow
    .step("read_rules")
    .description("Read the rules before working on a bug.")
    .schema({})
    .func(() =>
      reply({ rules: ["Reproduce before changing code.", "Close only after tests pass."] }),
    );

  const reproduce = flow
    .step("reproduce", { locked: true })
    .dependsOn(read)
    .description("Reproduce the whitespace bug for a ticket.")
    .schema({ ticket: z.string() })
    .func(({ ticket }) =>
      reply({ ticket, failure: "normalize(' baton ') should return 'baton'." }),
    );

  const fix = flow
    .step("fix", {
      locked: true,
      from: { ticket: reproduce.output((result) => result.structuredContent.ticket) },
    })
    .description("Apply a patch to the reproduced ticket.")
    .schema({ ticket: z.string(), patch: patchSchema })
    .func(({ ticket, patch }) => {
      patches.set(ticket, patch);

      return reply({ ticket, patch });
    });

  const test = flow
    .step("run_tests", {
      locked: true,
      from: {
        ticket: fix.output((result) => result.structuredContent.ticket),
        patch: fix.output((result) => result.structuredContent.patch),
      },
    })
    .description("Test the exact patch that was applied.")
    .schema({ ticket: z.string(), patch: patchSchema })
    .func(({ ticket, patch }) => {
      if (patches.get(ticket) !== patch) {
        throw new Error("The patch changed. Apply and test the current patch.");
      }

      const normalize = (value: string) => (patch === "trim-input" ? value.trim() : value);
      const passed = normalize(" baton ") === "baton";

      return reply({
        ticket,
        patch,
        passed,
        failures: passed ? [] : ["Whitespace is not trimmed."],
      });
    });

  const close = flow
    .step("close", {
      locked: true,
      from: {
        ticket: test.output((result) => result.structuredContent.ticket),
        patch: test.output((result) => result.structuredContent.patch),
      },
    })
    .description("Close a ticket after its current patch passes tests.")
    .schema({ ticket: z.string(), patch: patchSchema })
    .func(({ ticket, patch }) => {
      if (patches.get(ticket) !== patch) {
        throw new Error("The patch changed. Apply and test the current patch.");
      }

      if (closed.has(ticket)) {
        throw new Error("The ticket is already closed.");
      }

      closed.add(ticket);

      return reply({ ticket, closed: true });
    });

  test.branch({
    when: (result) => result.structuredContent.passed,
    pass: close,
    fail: fix,
  });

  return { flow, read, reproduce, fix, test, close };
};

export const createTools = (
  secret = process.env.BATON_SECRET ?? "",
): ReturnType<typeof configureTools> => configureTools(secret);

export const createServer = (secret = process.env.BATON_SECRET ?? ""): McpServer => {
  const { flow, read, reproduce, fix, test, close } = createTools(secret);
  const server = new McpServer({ name: "bug-tools", version: "0.1.0" });

  server.registerTool(
    read.name,
    { description: read.description, inputSchema: read.schema },
    read.func,
  );
  server.registerTool(
    reproduce.name,
    { description: reproduce.description, inputSchema: reproduce.schema },
    reproduce.func,
  );
  server.registerTool(
    fix.name,
    { description: fix.description, inputSchema: fix.schema },
    fix.func,
  );
  server.registerTool(
    test.name,
    { description: test.description, inputSchema: test.schema },
    test.func,
  );
  server.registerTool(
    close.name,
    { description: close.description, inputSchema: close.schema },
    close.func,
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
