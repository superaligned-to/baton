import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { challenge } from "@superaligned/baton";
import { baton } from "@superaligned/baton/zod";
import { z } from "zod";

type Extra = { authInfo?: AuthInfo };

export interface Store {
  inbox: Map<string, string[]>;
  docs: string[];
  freeze: boolean;
}

export const createStore = (): Store => ({ inbox: new Map(), docs: [], freeze: false });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const caller = (extra: Extra): string => extra.authInfo?.clientId ?? "anonymous";

export const createServer = (
  secret = process.env.BATON_SECRET ?? "",
  store: Store = createStore(),
): McpServer => {
  const server = new McpServer({ name: "challenge-tools", version: "0.1.0" });

  const handbook = baton({ name: "handbook", secret, mcp: true });

  const readRules = handbook
    .step("read_rules")
    .description("Read the writing rules.")
    .schema({})
    .func(async () => text("Write for the next reader."));

  const readInbox = {
    name: "read_inbox",
    description: "Read your unread messages. Marks them read.",
    schema: {},
    func: async (_args: object, extra: Extra) => {
      const mail = store.inbox.get(caller(extra)) ?? [];

      store.inbox.delete(caller(extra));

      return text(JSON.stringify(mail));
    },
  };

  const inboxRead = challenge({ name: "read-inbox", mcp: true })
    .call(readInbox)
    .check(async (_args: object, extra: Extra) => !store.inbox.has(caller(extra)));

  const rulesRead = challenge({ name: "read-rules", mcp: true }).call(readRules);

  const freezeOver = challenge({
    name: "release-freeze",
    description: "wait until the release freeze ends",
    mcp: true,
  }).check(async () => !store.freeze);

  const publishing = baton({ name: "publish-document", secret, mcp: true });

  const check = publishing
    .step("check_doc")
    .withChallenge(inboxRead)
    .description("Check that the document starts with a Markdown heading.")
    .schema({ text: z.string() })
    .func(({ text: body }) => ({
      ...text("Document checked."),
      structuredContent: { text: body, passed: body.startsWith("# ") },
    }));

  const publish = publishing
    .step("publish_doc", { from: { text: check.output((r) => r.structuredContent.text) } })
    .withChallenge(rulesRead)
    .withChallenge(freezeOver)
    .description("Publish the exact text that passed its check.")
    .schema({ text: z.string() })
    .func(async ({ text: body }) => {
      store.docs.push(body);

      return text("Document published.");
    });

  check.branch({ when: (r) => r.structuredContent.passed, pass: publish, fail: check });

  const list = {
    name: "list_docs",
    description: "List published documents.",
    schema: {},
    func: inboxRead.func(async (_args: object, _extra: Extra) => text(JSON.stringify(store.docs))),
  };

  for (const tool of [readInbox, list]) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      tool.func,
    );
  }

  for (const tool of [readRules, check, publish]) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      tool.func,
    );
  }

  for (const tool of publishing.metaTools()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      tool.func,
    );
  }

  return server;
};
