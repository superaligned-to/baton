import { describe, expect, it } from "vitest";
import { z } from "zod";
import { challenge } from "./challenge.ts";
import type { Reply } from "./flow-contract.ts";
import { baton } from "./index.ts";
import { baton as zodBaton } from "./zod.ts";

const secret = "dev-only-secret-of-at-least-32-bytes";

const proofOf = (reply: Reply<unknown>): string => {
  if (reply.proof_token === null) {
    throw new Error("expected proof");
  }

  return reply.proof_token;
};

const handbook = (now?: () => number) => {
  const flow = baton(
    now === undefined ? { name: "handbook", secret } : { name: "handbook", secret, now },
  );

  const rules = flow
    .step("read_rules", { ttl: 60 })
    .description("Read the rules")
    .func(() => ({ rules: ["Write for the next reader."] }));

  return { flow, rules };
};

describe("check challenges", () => {
  it("refuse before the handler runs until the host check passes", async () => {
    let unread = 1;
    let calls = 0;
    const seen: unknown[] = [];

    const inbox = challenge({ name: "read-inbox" })
      .call({ name: "read_inbox", description: "Read mail", func: async () => [] })
      .check(async (args: object, who: string) => {
        seen.push(args, who);

        return unread === 0;
      });

    const flow = baton({ name: "inbox-check", secret });

    const save = flow
      .step("save")
      .withChallenge(inbox)
      .description("Save")
      .func((args: { doc: string }, who: string) => {
        calls++;

        return { saved: args.doc, who };
      });

    await expect(save({ doc: "a" }, "agent-1")).rejects.toMatchObject({
      code: "challenge_required",
      message: "This tool is locked by challenge: read-inbox. Solve it to unlock: call read_inbox.",
    });
    expect(calls).toBe(0);
    expect(seen).toEqual([{ doc: "a" }, "agent-1"]);

    unread = 0;

    const done = await save({ doc: "a" }, "agent-1");

    expect(done.result).toEqual({ saved: "a", who: "agent-1" });
    expect(done.proof_token).toMatch(/^bt1\.inbox-check\./);
  });

  it("wraps plain handlers and lets the challenge's own tool through", async () => {
    let open = false;

    const freeze = challenge({
      name: "release-freeze",
      description: "wait for the freeze to end",
    }).check(() => open);

    const list = freeze.func(async (args: { q: string }) => `found ${args.q}`);

    await expect(list({ q: "docs" })).rejects.toMatchObject({
      code: "challenge_required",
      message:
        "This tool is locked by challenge: release-freeze. Solve it to unlock: wait for the freeze to end.",
    });

    open = true;

    await expect(list({ q: "docs" })).resolves.toBe("found docs");
    expect(freeze.lets("anything")).toBe(false);

    const inbox = challenge({ name: "read-inbox" })
      .call({ name: "read_inbox", description: "Read mail", func: async () => [] })
      .check(() => true);

    expect(inbox.lets("read_inbox")).toBe(true);
    expect(inbox.lets("save")).toBe(false);
  });

  it("returns MCP refusals as error results when configured", async () => {
    const locked = challenge({ name: "locked", description: "ask an admin", mcp: true })
      .check(() => false)
      .func(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));

    await expect(locked({})).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "challenge_required: This tool is locked by challenge: locked. Solve it to unlock: ask an admin.",
        },
      ],
      isError: true,
    });
  });
});

describe("proof challenges", () => {
  it("accept proof from another flow and route only the step's own tokens to its engine", async () => {
    const { rules } = handbook();
    const flow = baton({ name: "publishing", secret });

    const check = flow
      .step("check_doc")
      .description("Check")
      .func((args: { text: string }) => ({ text: args.text }));

    let published = 0;

    const publish = flow
      .step("publish_doc", { from: { text: check.output((result) => result.text) } })
      .withChallenge(challenge({ name: "read-rules" }).call(rules))
      .description("Publish")
      .func((args: { text: string }) => {
        published++;

        return { published: args.text };
      });

    const checked = proofOf(await check({ text: "# Notes" }));

    await expect(publish({ text: "# Notes", proof_token: checked })).rejects.toMatchObject({
      code: "challenge_required",
      message: "This tool is locked by challenge: read-rules. Solve it to unlock: call read_rules.",
    });

    const read = proofOf(await rules({}));
    const done = await publish({ text: "# Notes", proof_token: [checked, read] });

    expect(done.result).toEqual({ published: "# Notes" });
    await expect(
      publish({ text: "# Notes", proof_token: [checked, read, checked] }),
    ).resolves.toMatchObject({ result: { published: "# Notes" } });
    expect(published).toBe(2);
    await expect(publish({ text: "# Notes", proof_token: [read] })).rejects.toMatchObject({
      code: "token_required",
    });
  });

  it("refuses expired, forged, and unrelated proof", async () => {
    let time = 1_000;
    const { rules } = handbook(() => time);
    const { rules: other } = (() => {
      const flow = baton({ name: "elsewhere", secret });

      return {
        rules: flow
          .step("read_rules")
          .description("Unrelated rules")
          .func(() => ({})),
      };
    })();

    const gated = challenge({ name: "read-rules" })
      .call(rules)
      .func(async () => "published");

    const read = proofOf(await rules({}));
    const forged = `${read.slice(0, -4)}AAAA`;
    const unrelated = proofOf(await other({}));

    await expect(gated({ proof_token: read })).resolves.toBe("published");
    await expect(gated({ proof_token: forged })).rejects.toMatchObject({
      code: "challenge_required",
    });
    await expect(gated({ proof_token: unrelated })).rejects.toMatchObject({
      code: "challenge_required",
    });
    await expect(
      gated({ proof_token: [`bt1.handbook.${"x".repeat(70_000)}`, "bt1.handbook"] }),
    ).rejects.toMatchObject({ code: "challenge_required" });
    await expect(gated({ proof_token: [7, null] as never })).rejects.toMatchObject({
      code: "challenge_required",
    });
    await expect(gated({ proof_token: "" })).rejects.toMatchObject({
      code: "challenge_required",
    });
    await expect(gated({})).rejects.toMatchObject({ code: "challenge_required" });

    time += 61;

    await expect(gated({ proof_token: read })).rejects.toMatchObject({
      code: "challenge_required",
    });
  });

  it("solves a follow challenge only with proof that its finishing step ran", async () => {
    const policy = baton({ name: "policy", secret });

    const help = policy
      .step("policy_help")
      .description("Explain the policy")
      .func(() => ({ help: true }));

    const read = policy
      .step("policy_read")
      .description("Read the policy")
      .func(() => ({ version: 2 }));

    const ack = policy
      .step("policy_ack", { from: { version: read.output((result) => result.version) } })
      .description("Acknowledge the version you read")
      .func((args: { version: number }) => ({ acked: args.version }));

    const acked = challenge({ name: "policy-acked" }).follow(policy, ack);
    const deploy = acked.func(async () => "deployed");

    await expect(deploy({})).rejects.toMatchObject({
      message:
        "This tool is locked by challenge: policy-acked. Solve it to unlock: complete flow policy: start with policy_help or policy_read and finish with policy_ack.",
    });

    await expect(deploy({ proof_token: proofOf(await help({})) })).rejects.toMatchObject({
      code: "challenge_required",
    });

    const started = proofOf(await read({}));

    await expect(deploy({ proof_token: started })).rejects.toMatchObject({
      code: "challenge_required",
    });

    const finished = proofOf(await ack({ version: 2, proof_token: started }));

    await expect(deploy({ proof_token: finished })).resolves.toBe("deployed");
    expect(acked.lets("policy_read")).toBe(true);
    expect(acked.lets("policy_ack")).toBe(true);
    expect(acked.lets("deploy")).toBe(false);
  });

  it("propagates application errors raised while reading proof", async () => {
    const draft = baton({ name: "draft", secret });

    const start = draft
      .step("start")
      .description("Start")
      .func(() => ({}));

    draft.step("unfinished").description("Never bound");

    const gated = challenge({ name: "drafted" })
      .follow(draft, start)
      .func(async () => "never");

    await expect(gated({ proof_token: "bt1.draft.unfinished>~.e30.sig" })).rejects.toThrow(
      TypeError,
    );
  });
});

describe("steps with challenges", () => {
  it("refuses a challenge from the step's own flow and never skips one by name", async () => {
    const { rules } = handbook();
    const flow = baton({ name: "own", secret });

    const first = flow
      .step("first")
      .description("First")
      .func(() => ({}));

    expect(() =>
      flow
        .step("second")
        .withChallenge(challenge({ name: "same-flow" }).call(first))
        .description("Second"),
    ).toThrow("second cannot be challenged by its own flow; use dependsOn");

    const lookalike = flow
      .step("read_rules")
      .withChallenge(challenge({ name: "read-rules" }).call(rules))
      .description("Same name, other flow")
      .func(() => ({ read: true }));

    await expect(lookalike({})).rejects.toMatchObject({ code: "challenge_required" });
  });

  it("leaves non-object arguments to the engine's own checks", async () => {
    const flow = baton({ name: "shape", secret });

    const step = flow
      .step("save")
      .withChallenge(challenge({ name: "open", description: "wait" }).check(() => true))
      .description("Save")
      .func(() => ({}));

    await expect(step(null as never)).rejects.toThrow("tool arguments must be an object");
  });

  it("keeps unrecognised tokens for the engine to judge", async () => {
    const flow = baton({ name: "judge", secret });

    const first = flow
      .step("first")
      .description("First")
      .func(() => ({}));

    const second = flow
      .step("second")
      .dependsOn(first)
      .withChallenge(challenge({ name: "open", description: "wait" }).check(() => true))
      .description("Second")
      .func(() => ({}));

    await expect(second({ proof_token: "not-a-token" })).rejects.toMatchObject({
      code: "token_invalid",
    });
  });

  it("refuses MCP steps with an error result", async () => {
    const flow = zodBaton({ name: "mcp-steps", secret, mcp: true });
    const closed = challenge({ name: "closed", description: "wait" }).check(() => false);
    const reply = { content: [{ type: "text" as const, text: "ok" }] };

    const steps = [
      flow
        .step("bare")
        .withChallenge(closed)
        .description("Bare")
        .schema({})
        .func(() => reply),
      flow
        .step("described")
        .description("Described")
        .withChallenge(closed)
        .schema({})
        .func(() => reply),
      flow
        .step("shaped")
        .schema({ doc: z.string() })
        .withChallenge(closed)
        .description("Shaped")
        .func(() => reply),
      flow
        .step("ready")
        .description("Ready")
        .schema({})
        .withChallenge(closed)
        .func(() => reply),
    ];

    for (const step of steps) {
      await expect(step.func({ doc: "a" } as never)).resolves.toEqual({
        content: [
          {
            type: "text",
            text: "challenge_required: This tool is locked by challenge: closed. Solve it to unlock: wait.",
          },
        ],
        isError: true,
      });
    }
  });
});

describe("challenge definitions", () => {
  it("rejects invalid names, descriptions, and targets", () => {
    const tool = { name: "plain", description: "Plain", func: async () => null };

    expect(() => challenge({ name: "has space" })).toThrow("challenge names");
    expect(() => challenge({ name: 7 as never })).toThrow("challenge names");
    expect(() => challenge({ name: "blank", description: " " })).toThrow("nonempty");
    expect(() => challenge({ name: "twice" }).call(tool).call(tool)).toThrow("one .call()");
    expect(() =>
      challenge({ name: "checks" })
        .check(() => true)
        .check(() => true),
    ).toThrow("one .check()");
    expect(() => challenge({ name: "loose" }).follow(handbook().flow, tool)).toThrow(
      "must finish with a step of flow handbook",
    );
    expect(() =>
      challenge({ name: "plain" }).follow({ name: "plain", graph: handbook().flow.graph }, tool),
    ).toThrow("must finish with a step of flow plain");
    expect(() =>
      challenge({ name: "nothing" })
        .check(() => true)
        .lets("x"),
    ).toThrow("needs a description");
    expect(() => challenge({ name: "unproven" }).call(tool).lets("x")).toThrow("needs .check()");
    expect(() => challenge({ name: "described", description: "wait" }).lets("x")).toThrow(
      "needs .check()",
    );
  });

  it("refuses challenges on finished steps and values not made by challenge()", () => {
    const flow = baton({ name: "finished", secret });
    const open = challenge({ name: "open", description: "wait" }).check(() => true);
    const stage = flow.step("done").description("Done");

    stage.func(() => ({}));

    expect(() => stage.withChallenge(open)).toThrow("finished steps cannot change challenges");
    expect(() =>
      flow
        .step("fake")
        .withChallenge({ name: "fake" } as never)
        .description("Fake"),
    ).toThrow("needs a challenge from challenge()");
  });
});
