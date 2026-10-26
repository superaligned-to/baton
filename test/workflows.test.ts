import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BatonError } from "@superaligned/baton";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as createBugs } from "./fixtures/bug.ts";
import { createServer as createDocs } from "./fixtures/document.ts";
import { createTools } from "./fixtures/plain.ts";
import { createServer as createRelease } from "./fixtures/release.ts";
import { createServer as createSupport } from "./fixtures/support.ts";

const secret = "dev-only-secret-of-at-least-32-bytes";

const clients: Client[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const connect = async (server: McpServer): Promise<Client> => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "example-test", version: "0.1.0" });

  await Promise.all([server.connect(st), client.connect(ct)]);
  clients.push(client);

  return client;
};

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

const out = (result: ToolResult): string =>
  Array.isArray(result.content)
    ? result.content.map((block) => String(block?.text ?? "")).join("\n")
    : "";

const tokenOf = (result: ToolResult): string => {
  const structured = result.structuredContent;

  const token =
    typeof structured === "object" &&
    structured !== null &&
    "proof_token" in structured &&
    typeof structured.proof_token === "string"
      ? structured.proof_token
      : /proof_token: (\S+)/.exec(out(result))?.[1];

  expect(token).toMatch(/^bt1\./);

  return token ?? "";
};

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args });

const doc = "README.md";

const goodText =
  "# Release notes\nThis release improves document publishing and fixes reported bugs.";

describe("document publishing example", () => {
  it("registers the full flow and gated baton meta tools", async () => {
    const client = await connect(createDocs(secret));
    const tools = (await client.listTools()).tools;

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "read_guidelines",
        "save_doc",
        "check_doc",
        "publish_doc",
        "baton_status",
        "baton_list",
        "baton_refresh",
        "baton_workflows",
      ]),
    );
    expect(
      tools.find((tool) => tool.name === "get_doc")?.inputSchema.properties,
    ).not.toHaveProperty("proof_token");
    expect(tools.find((tool) => tool.name === "save_doc")?.inputSchema.properties).toHaveProperty(
      "proof_token",
    );

    const missing = await call(client, "save_doc", { doc, text: goodText });

    expect(missing.isError).toBe(true);
    expect(out(missing)).toMatch(/^token_required:/);

    const hidden = await call(client, "baton_list");

    expect(hidden.isError).toBe(true);
    expect(out(hidden)).toMatch(/^token_required:/);
  });

  it("publishes the exact saved and checked text without a status call", async () => {
    const client = await connect(createDocs(secret));
    const read = await call(client, "read_guidelines");

    expect(out(read)).toContain("save_doc");

    const saved = await call(client, "save_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(read),
    });

    expect(out(saved)).toContain("check_doc");

    const checked = await call(client, "check_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(saved),
    });

    expect(checked.structuredContent).toMatchObject({ passed: true });
    expect(out(checked)).toContain("publish_doc");

    const published = await call(client, "publish_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(checked),
    });

    expect(published.isError).not.toBe(true);
    expect(published.structuredContent).toMatchObject({ doc, published: true });
    expect(out(published)).toContain("This flow is finished.");
    expect(tokenOf(published)).toContain(">~.");

    const current = await call(client, "get_doc", { doc });

    expect(current.structuredContent).toMatchObject({ doc, text: goodText, published: true });
  });

  it("refuses a different document or text at a linked step", async () => {
    const client = await connect(createDocs(secret));
    const read = await call(client, "read_guidelines");

    const saved = await call(client, "save_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(read),
    });

    for (const replacement of [
      { doc: "OTHER.md", text: goodText },
      { doc, text: "# Changed after saving" },
    ]) {
      const refused = await call(client, "check_doc", {
        ...replacement,
        proof_token: tokenOf(saved),
      });

      expect(refused.isError).toBe(true);
      expect(out(refused)).toMatch(/^input_mismatch:/);
    }
  });

  it("returns a failed check to drafting and requires the revised draft to pass", async () => {
    const client = await connect(createDocs(secret));
    const read = await call(client, "read_guidelines");

    const saved = await call(client, "save_doc", {
      doc,
      text: "Too short.",
      proof_token: tokenOf(read),
    });

    const failed = await call(client, "check_doc", {
      doc,
      text: "Too short.",
      proof_token: tokenOf(saved),
    });

    expect(failed.structuredContent).toMatchObject({ passed: false });
    expect(out(failed)).toContain("save_doc");

    const refused = await call(client, "publish_doc", {
      doc,
      text: "Too short.",
      proof_token: tokenOf(failed),
    });

    expect(refused.isError).toBe(true);

    const revised = await call(client, "save_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(failed),
    });

    const checked = await call(client, "check_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(revised),
    });

    const published = await call(client, "publish_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(checked),
    });

    expect(published.isError).not.toBe(true);
  });

  it("checks current application state and protects duplicate publication", async () => {
    const client = await connect(createDocs(secret));
    const read = await call(client, "read_guidelines");

    const saved = await call(client, "save_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(read),
    });

    const checked = await call(client, "check_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(saved),
    });

    const args = { doc, text: goodText, proof_token: tokenOf(checked) };

    expect((await call(client, "publish_doc", args)).isError).not.toBe(true);
    expect(out(await call(client, "publish_doc", args))).toContain("already published");

    await call(client, "save_doc", {
      doc,
      text: "# Another draft",
      proof_token: tokenOf(read),
    });
    expect(
      out(
        await call(client, "check_doc", {
          doc,
          text: goodText,
          proof_token: tokenOf(saved),
        }),
      ),
    ).toContain("draft changed");
    expect(out(await call(client, "publish_doc", args))).toContain("draft changed");
  });

  it("refreshing an envelope does not renew expired guideline evidence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const client = await connect(createDocs(secret));
    const read = await call(client, "read_guidelines");

    vi.setSystemTime(Date.now() + 901_000);

    const expired = await call(client, "save_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(read),
    });

    expect(expired.isError).toBe(true);
    expect(out(expired)).toMatch(/^token_expired:/);

    const status = await call(client, "baton_status", { proof_token: tokenOf(read) });

    expect(status.isError).toBe(true);

    const refreshed = await call(client, "baton_refresh", { proof_token: tokenOf(read) });

    expect(refreshed.isError).not.toBe(true);

    const stale = await call(client, "save_doc", {
      doc,
      text: goodText,
      proof_token: tokenOf(refreshed),
    });

    expect(stale.isError).toBe(true);
  });
});

describe("bug workflow example", () => {
  const ticket = "BUG-7";

  it("requires reproduction, loops on failed tests, and closes only the tested patch", async () => {
    const client = await connect(createBugs(secret));
    const rules = await call(client, "read_rules");

    const skipped = await call(client, "fix", {
      ticket,
      patch: "trim-input",
      proof_token: tokenOf(rules),
    });

    expect(skipped.isError).toBe(true);

    const reproduced = await call(client, "reproduce", { ticket, proof_token: tokenOf(rules) });

    const fixed = await call(client, "fix", {
      ticket,
      patch: "keep-input",
      proof_token: tokenOf(reproduced),
    });

    const failed = await call(client, "run_tests", {
      ticket,
      patch: "keep-input",
      proof_token: tokenOf(fixed),
    });

    expect(failed.structuredContent).toMatchObject({ passed: false });
    expect(out(failed)).toContain("fix");

    const refused = await call(client, "close", {
      ticket,
      patch: "keep-input",
      proof_token: tokenOf(failed),
    });

    expect(refused.isError).toBe(true);

    const revised = await call(client, "fix", {
      ticket,
      patch: "trim-input",
      proof_token: tokenOf(failed),
    });

    const passing = await call(client, "run_tests", {
      ticket,
      patch: "trim-input",
      proof_token: tokenOf(revised),
    });

    expect(passing.structuredContent).toMatchObject({ passed: true });

    const wrongTicket = await call(client, "close", {
      ticket: "OTHER-1",
      patch: "trim-input",
      proof_token: tokenOf(passing),
    });

    expect(out(wrongTicket)).toMatch(/^input_mismatch:/);

    const closed = await call(client, "close", {
      ticket,
      patch: "trim-input",
      proof_token: tokenOf(passing),
    });

    expect(closed.isError).not.toBe(true);
    expect(closed.structuredContent).toMatchObject({ ticket, closed: true });
    expect(out(closed)).toContain("This flow is finished.");
  });
});

describe("plain handler example", () => {
  it("throws a typed refusal and binds edits to the document that was read", async () => {
    const tools = createTools(secret);

    await expect(tools.edit_doc({ doc, text: "# New" })).rejects.toBeInstanceOf(BatonError);

    const read = await tools.read_doc({ doc });

    await expect(
      tools.edit_doc({
        doc: "OTHER.md",
        text: "# New",
        proof_token: read.proof_token,
      }),
    ).rejects.toMatchObject({ code: "input_mismatch" });

    const edited = await tools.edit_doc({ doc, text: "# New", proof_token: read.proof_token });

    expect(edited.result).toEqual({ doc, text: "# New" });
    expect(edited.next).toEqual([]);
    expect(edited.proof_token).toMatch(/^bt1\./);
    expect(tools.get_doc(doc)).toBe("# New");
  });
});

describe("support triage tree", () => {
  it.each([
    {
      summary: "The export button is broken",
      category: "bug",
      urgent: false,
      middle: "reproduce_bug",
      leaf: "queue_bug",
      wrong: "prepare_incident",
      action: "bug-queue",
    },
    {
      summary: "Production outage in the export service",
      category: "bug",
      urgent: true,
      middle: "reproduce_bug",
      leaf: "prepare_incident",
      wrong: "queue_bug",
      action: "incident-handoff",
    },
    {
      summary: "My invoice total is incorrect",
      category: "billing",
      urgent: false,
      middle: "inspect_account",
      leaf: "prepare_billing_reply",
      wrong: "prepare_access_reply",
      action: "billing-reply",
    },
    {
      summary: "I cannot login to my account",
      category: "access",
      urgent: false,
      middle: "inspect_account",
      leaf: "prepare_access_reply",
      wrong: "prepare_billing_reply",
      action: "access-reply",
    },
  ])("routes $category / $urgent to $leaf and refuses its sibling", async (scenario) => {
    const client = await connect(createSupport(secret));
    const ticket = "SUP-42";
    const triaged = await call(client, "triage_ticket", { ticket, summary: scenario.summary });

    const inspected = await call(client, scenario.middle, {
      ticket,
      ...(scenario.middle === "reproduce_bug"
        ? { summary: scenario.summary, urgent: scenario.urgent }
        : { category: scenario.category }),
      proof_token: tokenOf(triaged),
    });

    expect(inspected.isError).not.toBe(true);

    const wrong = await call(client, scenario.wrong, { ticket, proof_token: tokenOf(inspected) });

    expect(wrong.isError).toBe(true);

    const prepared = await call(client, scenario.leaf, { ticket, proof_token: tokenOf(inspected) });

    expect(prepared.isError).not.toBe(true);
    expect(prepared.structuredContent).toMatchObject({
      ticket,
      action: scenario.action,
      prepared: true,
    });
    expect(out(prepared)).toContain("This flow is finished.");
  });
});

describe("artifact release join", () => {
  const packageName = "example-library";
  const content = "export const answer = 42;";

  const artifactOf = (result: ToolResult): string => {
    const data = result.structuredContent;

    if (
      typeof data !== "object" ||
      data === null ||
      !("artifact" in data) ||
      typeof data.artifact !== "string"
    ) {
      throw new Error("The build did not return its artifact identifier.");
    }

    return data.artifact;
  };

  it("joins sequential checks while refusing publication after only one", async () => {
    const client = await connect(createRelease(secret));
    const built = await call(client, "build_artifact", { packageName, content });
    const args = { packageName, artifact: artifactOf(built) };
    const tested = await call(client, "test_artifact", { ...args, proof_token: tokenOf(built) });

    const premature = await call(client, "publish_artifact", {
      ...args,
      proof_token: tokenOf(tested),
    });

    expect(premature.isError).toBe(true);

    const reviewed = await call(client, "review_artifact", {
      ...args,
      proof_token: tokenOf(tested),
    });

    const published = await call(client, "publish_artifact", {
      ...args,
      proof_token: tokenOf(reviewed),
    });

    expect(published.isError).not.toBe(true);
    expect(published.structuredContent).toMatchObject({
      ...args,
      published: true,
      registry: "memory",
    });
    expect(out(published)).toContain("This flow is finished.");
  });

  it("combines independent branch tokens from the same build run", async () => {
    const client = await connect(createRelease(secret));
    const built = await call(client, "build_artifact", { packageName, content });
    const args = { packageName, artifact: artifactOf(built) };

    const [tested, reviewed] = await Promise.all([
      call(client, "test_artifact", { ...args, proof_token: tokenOf(built) }),
      call(client, "review_artifact", { ...args, proof_token: tokenOf(built) }),
    ]);

    const changed = await call(client, "publish_artifact", {
      ...args,
      artifact: "different-artifact",
      proof_token: [tokenOf(tested), tokenOf(reviewed)],
    });

    expect(changed.isError).toBe(true);
    expect(out(changed)).toMatch(/^input_mismatch:/);

    const published = await call(client, "publish_artifact", {
      ...args,
      proof_token: [tokenOf(tested), tokenOf(reviewed)],
    });

    expect(published.isError).not.toBe(true);
    expect(published.structuredContent).toMatchObject({ ...args, published: true });
  });

  it("rejects a changed artifact and tokens from separate build runs", async () => {
    const client = await connect(createRelease(secret));
    const first = await call(client, "build_artifact", { packageName, content });
    const args = { packageName, artifact: artifactOf(first) };

    const changed = await call(client, "test_artifact", {
      ...args,
      artifact: "different-artifact",
      proof_token: tokenOf(first),
    });

    expect(out(changed)).toMatch(/^input_mismatch:/);

    const tested = await call(client, "test_artifact", { ...args, proof_token: tokenOf(first) });
    const second = await call(client, "build_artifact", { packageName, content });

    const reviewed = await call(client, "review_artifact", {
      ...args,
      proof_token: tokenOf(second),
    });

    const mixed = await call(client, "publish_artifact", {
      ...args,
      proof_token: [tokenOf(tested), tokenOf(reviewed)],
    });

    expect(mixed.isError).toBe(true);
    expect(out(mixed)).toMatch(/^dependency_conflict:/);
  });
});
