import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, createStore } from "./fixtures/challenge.ts";

const secret = "dev-only-secret-of-at-least-32-bytes";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

const out = (result: ToolResult): string =>
  Array.isArray(result.content)
    ? result.content.map((block) => String(block?.text ?? "")).join("\n")
    : "";

const tokenOf = (result: ToolResult): string => {
  const token = /proof_token: (\S+)/.exec(out(result))?.[1];

  expect(token).toMatch(/^bt1\./);

  return token ?? "";
};

describe("README challenge example", () => {
  it("replays the documented agent session", async () => {
    const store = createStore();
    const server = createServer(secret, store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "challenge-test", version: "0.1.0" });

    await Promise.all([server.connect(st), client.connect(ct)]);
    clients.push(client);

    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args });

    store.inbox.set("anonymous", ["Use the new template."]);
    store.freeze = true;

    const locked = await call("check_doc", { text: "# Release notes" });

    expect(locked.isError).toBe(true);
    expect(out(locked)).toBe(
      "challenge_required: This tool is locked by challenge: read-inbox. Solve it to unlock: call read_inbox.",
    );
    expect(out(await call("list_docs"))).toContain("challenge: read-inbox");
    expect(out(await call("read_inbox"))).toBe('["Use the new template."]');

    const checked = await call("check_doc", { text: "# Release notes" });
    const a = tokenOf(checked);

    expect(out(checked)).toContain('Next: publish_doc {"text":"# Release notes"}');

    const noRules = await call("publish_doc", { text: "# Release notes", proof_token: a });

    expect(out(noRules)).toBe(
      "challenge_required: This tool is locked by challenge: read-rules. Solve it to unlock: call read_rules.",
    );

    const rules = await call("read_rules");
    const r = tokenOf(rules);

    expect(out(rules)).toContain("This flow is finished.");

    const frozen = await call("publish_doc", { text: "# Release notes", proof_token: [a, r] });

    expect(out(frozen)).toBe(
      "challenge_required: This tool is locked by challenge: release-freeze. Solve it to unlock: wait until the release freeze ends.",
    );

    store.freeze = false;

    const published = await call("publish_doc", { text: "# Release notes", proof_token: [a, r] });

    expect(published.isError).toBeFalsy();
    expect(out(published)).toContain("Document published.");
    expect(store.docs).toEqual(["# Release notes"]);
    expect(out(await call("list_docs"))).toBe('["# Release notes"]');
  });
});
