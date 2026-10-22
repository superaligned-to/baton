import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { baton } from "@superaligned/baton/zod";
import { z } from "zod";

const reply = <Data extends Record<string, unknown>>(data: Data) => ({
  structuredContent: data,
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const configureTools = (secret: string) => {
  const categorySchema = z.enum(["bug", "billing", "access"]);
  const flow = baton({ name: "support-triage", secret, mcp: true });
  const prepare = (ticket: string, action: string) => {
    return reply({ ticket, action, prepared: true });
  };

  const triage = flow
    .step("triage_ticket")
    .description("Classify a support ticket and its urgency.")
    .schema({ ticket: z.string(), summary: z.string() })
    .func(({ ticket, summary }) => {
      const lower = summary.toLowerCase();

      const category: "bug" | "billing" | "access" = lower.includes("invoice")
        ? "billing"
        : lower.includes("login")
          ? "access"
          : "bug";

      return reply({ ticket, summary, category, urgent: lower.includes("outage") });
    });

  const reproduce = flow
    .step("reproduce_bug", {
      from: {
        ticket: triage.output((result) => result.structuredContent.ticket),
        summary: triage.output((result) => result.structuredContent.summary),
        urgent: triage.output((result) => result.structuredContent.urgent),
      },
    })
    .description("Record the reported bug and decide whether it needs incident handling.")
    .schema({ ticket: z.string(), summary: z.string(), urgent: z.boolean() })
    .func(({ ticket, summary, urgent }) => reply({ ticket, summary, urgent }));

  const inspect = flow
    .step("inspect_account", {
      from: {
        ticket: triage.output((result) => result.structuredContent.ticket),
        category: triage.output((result) => result.structuredContent.category),
      },
    })
    .description("Inspect whether an account ticket concerns billing or access.")
    .schema({ ticket: z.string(), category: categorySchema })
    .func(({ ticket, category }) => reply({ ticket, category }));

  const incident = flow
    .step("prepare_incident", {
      from: { ticket: reproduce.output((result) => result.structuredContent.ticket) },
    })
    .description("Prepare an incident handoff for an outage.")
    .schema({ ticket: z.string() })
    .func(({ ticket }) => prepare(ticket, "incident-handoff"));

  const queue = flow
    .step("queue_bug", {
      from: { ticket: reproduce.output((result) => result.structuredContent.ticket) },
    })
    .description("Prepare a normal bug queue entry.")
    .schema({ ticket: z.string() })
    .func(({ ticket }) => prepare(ticket, "bug-queue"));

  const billing = flow
    .step("prepare_billing_reply", {
      from: { ticket: inspect.output((result) => result.structuredContent.ticket) },
    })
    .description("Prepare a reply asking for the disputed invoice details.")
    .schema({ ticket: z.string() })
    .func(({ ticket }) => prepare(ticket, "billing-reply"));

  const access = flow
    .step("prepare_access_reply", {
      from: { ticket: inspect.output((result) => result.structuredContent.ticket) },
    })
    .description("Prepare an account recovery reply.")
    .schema({ ticket: z.string() })
    .func(({ ticket }) => prepare(ticket, "access-reply"));

  triage.branch({
    when: (result) => result.structuredContent.category === "bug",
    pass: reproduce,
    fail: inspect,
  });
  reproduce.branch({
    when: (result) => result.structuredContent.urgent,
    pass: incident,
    fail: queue,
  });
  inspect.branch({
    when: (result) => result.structuredContent.category === "billing",
    pass: billing,
    fail: access,
  });

  return { flow, triage, reproduce, inspect, incident, queue, billing, access };
};

export const createTools = (
  secret = process.env.BATON_SECRET ?? "",
): ReturnType<typeof configureTools> => configureTools(secret);

export const createServer = (secret = process.env.BATON_SECRET ?? ""): McpServer => {
  const { flow, triage, reproduce, inspect, incident, queue, billing, access } =
    createTools(secret);
  const server = new McpServer({ name: "support-tools", version: "0.1.0" });

  server.registerTool(
    triage.name,
    { description: triage.description, inputSchema: triage.schema },
    triage.func,
  );
  server.registerTool(
    reproduce.name,
    { description: reproduce.description, inputSchema: reproduce.schema },
    reproduce.func,
  );
  server.registerTool(
    inspect.name,
    { description: inspect.description, inputSchema: inspect.schema },
    inspect.func,
  );
  server.registerTool(
    incident.name,
    { description: incident.description, inputSchema: incident.schema },
    incident.func,
  );
  server.registerTool(
    queue.name,
    { description: queue.description, inputSchema: queue.schema },
    queue.func,
  );
  server.registerTool(
    billing.name,
    { description: billing.description, inputSchema: billing.schema },
    billing.func,
  );
  server.registerTool(
    access.name,
    { description: access.description, inputSchema: access.schema },
    access.func,
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
