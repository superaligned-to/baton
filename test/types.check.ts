import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { challenge, baton as plain, type TextResult } from "../src/index.ts";
import { baton } from "../src/zod.ts";

const secret = "dev-only-secret-of-at-least-32-bytes";

const reply = <T extends Record<string, unknown>>(value: T) => ({
  structuredContent: value,
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

const flow = baton({ name: "types", secret, mcp: true });

const source = flow
  .step("source")
  .description("Produce a document and count")
  .schema({ doc: z.string() })
  .func(({ doc }) => reply({ doc, count: 1 }));

const target = flow
  .step("target", {
    locked: true,
    from: {
      count: source.output((result) => result.structuredContent.count),
    },
  })
  .description("Use the count")
  .schema({ count: z.number() })
  .func(async ({ count }) => reply({ doubled: count * 2 }));

// @ts-expect-error
source.output((result) => result.structuredContent.missing);

// @ts-expect-error
source.output(() => new Date());

flow
  .step("bad-field", {
    from: { missing: source.output((result) => result.structuredContent.count) },
  })
  // @ts-expect-error
  .schema({ count: z.number() });

flow
  .step("bad-type", { from: { count: source.output((result) => result.structuredContent.doc) } })
  // @ts-expect-error
  .schema({ count: z.number() });

flow
  .step("bad-handler")
  .description("Numeric input")
  .schema({ count: z.number() })
  // @ts-expect-error
  .func(({ count }: { count: string }) => reply({ count }));

flow
  .step("no-schema")
  .description("Needs schema")
  // @ts-expect-error
  .func(() => reply({}));

flow
  .step("no-description")
  .schema({})
  // @ts-expect-error
  .func(() => reply({}));

flow
  .step("no-dependency", { locked: true })
  .description("Needs a prerequisite")
  .schema({})
  // @ts-expect-error
  .func(() => reply({}));

flow
  .step("empty-from", { locked: true, from: {} })
  .description("Needs a prerequisite")
  .schema({})
  // @ts-expect-error
  .func(() => reply({}));

flow
  .step("manual-token")
  // @ts-expect-error
  .schema({ proof_token: z.string() });

// @ts-expect-error
flow.step("typo", { locked: true, lockd: true });

// @ts-expect-error
flow.step("bad-ttl", { ttl: "300" });

const dynamic: { locked: boolean } = { locked: Math.random() > 0.5 };

flow
  .step("dynamic", dynamic)
  .description("Possibly locked")
  .schema({})
  // @ts-expect-error
  .func(() => reply({}));

// @ts-expect-error
flow.step("bad-ref").dependsOn("source");

// @ts-expect-error
flow.step("empty-ref").dependsOn();

// @ts-expect-error
target.dependsOn(source);

const unfinished = flow.step("unfinished");

// @ts-expect-error
flow.step("bad-unfinished").dependsOn(unfinished);

const other = baton({ name: "other", secret, mcp: true });

const unrelated = other
  .step("unrelated")
  .description("Other flow")
  .schema({})
  .func(() => reply({ count: 1 }));

// @ts-expect-error
flow.step("wrong-flow").dependsOn(unrelated);

flow.step("wrong-output-flow", {
  // @ts-expect-error
  from: { count: unrelated.output((result) => result.structuredContent.count) },
});

target.func({ count: 1 });

// @ts-expect-error
target.func({ proof_token: "example" });

// @ts-expect-error
target.func({ count: "one", proof_token: "example" });

const ordered = flow
  .step("ordered", { locked: true })
  .schema({})
  .dependsOn(source)
  .description("Description may follow schema")
  .func(() => reply({ done: true }));

const server = new McpServer({ name: "types", version: "0.1.0" });

server.registerTool(
  ordered.name,
  { description: ordered.description, inputSchema: ordered.schema },
  ordered.func,
);

const inline = flow
  .step("inline")
  .dependsOn(source)
  .description("Bind during registration")
  .schema({ doc: z.string() });

server.registerTool(
  inline.name,
  { description: inline.description, inputSchema: inline.schema },
  inline.func(({ doc }) => reply({ doc })),
);

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const contextual = flow
  .step("contextual")
  .description("Preserve SDK context")
  .schema({ doc: z.string() })
  .func(({ doc }, extra: Extra) => {
    const session: string | undefined = extra.sessionId;

    return reply({ doc, session: session ?? "none" });
  });

server.registerTool(
  contextual.name,
  { description: contextual.description, inputSchema: contextual.schema },
  contextual.func,
);

target.branch({
  when: (result) => result.structuredContent.doubled > 0,
  pass: ordered,
  fail: source,
});

target.branch({
  when: (result) => {
    // @ts-expect-error
    return result.structuredContent.absent;
  },
  pass: ordered,
  fail: source,
});

target.branch({
  when: () => true,
  // @ts-expect-error
  pass: "ordered",
  fail: source,
});

// @ts-expect-error
target.branch({ when: () => true, pass: ordered });

target.branch({
  when: () => true,
  // @ts-expect-error
  pass: unrelated,
  fail: source,
});

const core = plain({ name: "plain", secret });

const start = core
  .step("start")
  .description("Start")
  .func((args: { doc: string }) => ({ doc: args.doc, count: 1 }));

const finish = core
  .step("finish", {
    from: { count: start.output((result) => result.count) },
  })
  .description("Finish")
  .func((args: { count: number }) => args.count * 2);

core
  .step("plain-bad-input", { from: { count: start.output((result) => result.doc) } })
  .description("Wrong input")
  // @ts-expect-error
  .func((args: { count: number }) => args.count);

core
  .step("plain-missing-input", { from: { missing: start.output((result) => result.count) } })
  .description("Missing input")
  // @ts-expect-error
  .func((args: { count: number }) => args.count);

core
  .step("plain-token")
  .description("Reserved field")
  // @ts-expect-error
  .func((args: { proof_token: string }) => args.proof_token);

const mcpCore = plain({ name: "mcp-core", secret, mcp: true });

mcpCore
  .step("bad-result")
  .description("Needs an MCP result")
  // @ts-expect-error
  .func(() => "plain result");

// @ts-expect-error
plain({ name: "old-config", secret, subject: () => "doc" });

async function inferredOutput() {
  const result = await target.func({ count: 1, proof_token: ["one", "two"] });
  const compatible: CallToolResult = result;

  if ("structuredContent" in result && result.structuredContent !== undefined) {
    const doubled: number = result.structuredContent.doubled;
    // @ts-expect-error
    const wrong: string = result.structuredContent.doubled;

    void wrong;
    void doubled;
  }

  const plainResult = await finish.func({ count: 1, proof_token: "one" });
  const number: number = plainResult.result;

  return { compatible, number };
}

export { inferredOutput };

interface ArtifactPayload {
  readonly label: string;
  readonly ids: readonly number[];
}

const payload: ArtifactPayload = { label: "artifact", ids: [1, 2] };

const payloadSource = flow
  .step("payload-source")
  .description("Produce a typed payload")
  .schema({})
  .func(() => reply({ payload }));

const payloadRef = payloadSource.output((result) => result.structuredContent.payload);

const readonlyRef = source.output(() => ["a", "b"] as const);

flow
  .step("payload-target", { from: { payload: payloadRef } })
  .description("Consume serialized payload")
  .schema({ payload: z.object({ label: z.string(), ids: z.array(z.number()) }) })
  .func(({ payload }) => reply({ label: payload.label }));

void readonlyRef;

flow
  .step("transformed-link", {
    from: { count: source.output((result) => result.structuredContent.count) },
  })
  // @ts-expect-error
  .schema({ count: z.string().transform(Number) });

const sdkHandler = ({ doc }: { doc: string }): CallToolResult => reply({ doc });

const sdkStep = flow
  .step("sdk-typed")
  .description("Wrap an existing SDK handler")
  .schema({ doc: z.string() })
  .func(sdkHandler);

server.registerTool(
  sdkStep.name,
  { description: sdkStep.description, inputSchema: sdkStep.schema },
  sdkStep.func,
);

const sdkResult: Promise<CallToolResult> = sdkStep.func({ doc: "README.md" });

void sdkResult;

const proofLock = challenge({ name: "proof-lock" }).call(source);

const proofGated: (args: { doc: string }, extra: Extra) => Promise<string> = proofLock.func(
  async (_args: { doc: string }, extra: Extra) => String(extra.requestId),
);

const ctxLock = challenge({ name: "ctx-lock", description: "wait" }).check(
  async (_args: object, ctx: { agentId: string }) => ctx.agentId !== "",
);

ctxLock.func(async (_args: object, ctx: { agentId: string }) => ctx.agentId);

// @ts-expect-error
ctxLock.func(async (_args: object, ctx: { other: number }) => ctx.other);

const mcpLocked: Promise<CallToolResult | TextResult> = challenge({
  name: "mcp-lock",
  description: "wait",
  mcp: true,
})
  .check(() => true)
  .func(async () => reply({ ok: true }))({});

const plainLocked: Promise<string> = challenge({ name: "plain-lock", description: "wait" })
  .check(() => true)
  .func(async () => "ok")({});

flow.step("challenged").withChallenge(proofLock).description("Locked step");

// @ts-expect-error
challenge({ name: "no-end" }).follow(flow);

void proofGated;
void mcpLocked;
void plainLocked;
