import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Reply } from "./flow-contract.ts";
import { baton } from "./index.ts";
import { BatonError, type Claims, type JsonValue, sign } from "./token.ts";
import { baton as zodBaton } from "./zod.ts";

const secret = "dev-only-secret-of-at-least-32-bytes";

describe("fluent flow", () => {
  it("binds a downstream input to a source output without a common subject", async () => {
    const flow = baton({ name: "banner", secret });

    const choose = flow
      .step("choose")
      .description("Choose artwork")
      .func(({ doc, imageId }: { doc: string; imageId: string }) => ({ doc, imageId }));

    let calls = 0;

    const publish = flow
      .step("publish", {
        locked: true,
        from: {
          doc: choose.output((result) => result.doc),
          imageId: choose.output((result) => result.imageId),
        },
      })
      .description("Publish chosen artwork")
      .func(({ doc, imageId }: { doc: string; imageId: string }) => {
        calls++;

        return { doc, imageId, published: true };
      });

    await expect(publish.func({ doc: "README.md", imageId: "dark" })).rejects.toMatchObject({
      code: "token_required",
    });

    const selected = await choose.func({ doc: "README.md", imageId: "dark" });

    await expect(
      publish.func({ doc: "OTHER.md", imageId: "dark", proof_token: selected.proof_token }),
    ).rejects.toMatchObject({ code: "input_mismatch" });
    expect(calls).toBe(0);

    const done = await publish.func({
      doc: "README.md",
      imageId: "dark",
      proof_token: selected.proof_token,
    });

    expect(done.result.published).toBe(true);
    expect(done.next).toEqual([]);
    expect(done.proof_token).toMatch(/^bt1\./);
  });
});

const proofOf = (reply: Reply<unknown>): string => {
  if (reply.proof_token === null) {
    throw new Error("Expected a signed proof");
  }

  return reply.proof_token;
};

const claimsOf = (token: string): Claims => {
  const payload = token.split(".").at(-2);

  if (payload === undefined) {
    throw new Error("Expected a token payload");
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Claims;
};

const resign = (token: string, change: (claims: Claims) => void): string => {
  const claims = claimsOf(token);

  change(claims);

  return sign(secret, claims);
};

const setup = (options: { ttl?: number; locked?: boolean; grace?: number } = {}) => {
  const clock = { time: 100 };

  const flow = baton({
    name: "binding",
    secret,
    now: () => clock.time,
    ...(options.grace === undefined ? {} : { grace: options.grace }),
  });

  const source = flow
    .step("source", { ttl: options.ttl ?? 900 })
    .description("Produce selected data")
    .func((args: { doc: string; value?: JsonValue }) => ({
      doc: args.doc,
      value: args.value ?? 1,
    }));

  let calls = 0;

  const target = flow
    .step("target", {
      ...(options.locked === undefined ? {} : { locked: options.locked }),
      from: {
        doc: source.output((result) => result.doc),
        value: source.output((result) => result.value),
      },
    })
    .description("Consume selected data")
    .func((args: { doc: string; value: JsonValue }) => {
      calls++;

      return args;
    });

  return { flow, source, target, clock, calls: () => calls };
};

describe("dependency evidence", () => {
  it("exposes linked values and graph only after verification", async () => {
    const f = setup();
    const selected = await f.source.func({ doc: "README.md", value: { nested: [null, true, 3] } });
    const token = proofOf(selected);

    expect(selected.next).toEqual([
      { tool: "target", inputs: { doc: "README.md", value: { nested: [null, true, 3] } } },
    ]);
    expect(await f.flow.status({ proof_token: token })).toMatchObject({
      completed: ["source"],
      expires_in: 900,
      next: selected.next,
    });
    expect(await f.flow.list({ proof_token: token })).toMatchObject({
      entries: ["source"],
      steps: [
        { tool: "source", locked: false, ttl: 900 },
        {
          tool: "target",
          locked: true,
          dependencies: ["source"],
          inputs: { doc: { tool: "source", output: "0" } },
        },
      ],
    });
    await expect(f.flow.list({ proof_token: "bad" })).rejects.toMatchObject({
      code: "token_invalid",
    });
    await expect(f.flow.status({ proof_token: "" })).rejects.toMatchObject({
      code: "token_required",
    });
  });

  it("strips the proof argument before calling the original handler and preserves extra context", async () => {
    const flow = baton({ name: "context", secret });
    const seen: unknown[] = [];

    const source = flow
      .step("source")
      .description("Start")
      .func(() => 1);

    const target = flow
      .step("target")
      .dependsOn(source)
      .description("Use context")
      .func((args: { value: string }, extra: { session: string }) => {
        seen.push(args, extra);

        return extra.session;
      });

    const start = await source.func({});

    const response = await target.func(
      { value: "one", proof_token: proofOf(start) },
      { session: "caller" },
    );

    expect(response.result).toBe("caller");
    expect(seen).toEqual([{ value: "one" }, { session: "caller" }]);
  });

  it("supports JSON values regardless of object key insertion order", async () => {
    const f = setup();
    const selected = await f.source.func({ doc: "README.md", value: { b: 2, a: [false, null] } });

    const result = await f.target.func({
      doc: "README.md",
      value: { a: [false, null], b: 2 },
      proof_token: proofOf(selected),
    });

    expect(result.result.value).toEqual({ a: [false, null], b: 2 });
  });

  it("supports null-prototype JSON and reserved object keys without prototype mutation", async () => {
    const flow = baton({ name: "reserved", secret });

    const start = flow
      .step("__proto__")
      .description("Start")
      .func(() => Object.assign(Object.create(null), { count: 1 }));

    const finish = flow
      .step("constructor", { from: { value: start.output((result) => result) } })
      .description("Finish")
      .func((args: { value: JsonValue }) => args.value);

    const selected = await start.func({});
    const done = await finish.func({ value: { count: 1 }, proof_token: proofOf(selected) });

    expect(done.result).toEqual({ count: 1 });
    expect(Object.keys(claimsOf(proofOf(done)).evidence)).toEqual(["__proto__", "constructor"]);
  });

  it("does not run a locked handler for malformed, empty-array, or missing proof", async () => {
    const f = setup();

    for (const proof_token of [undefined, null, "", [], "bad"] as const) {
      await expect(f.target.func({ doc: "a", value: 1, proof_token })).rejects.toBeInstanceOf(
        BatonError,
      );
    }

    expect(f.calls()).toBe(0);
  });

  it("permits explicitly unlocked work but does not issue usable evidence when prerequisites fail", async () => {
    const f = setup({ locked: false });
    const unguarded = await f.target.func({ doc: "a", value: 1 });

    expect(unguarded).toMatchObject({
      result: { doc: "a", value: 1 },
      proof_token: null,
      warning: { code: "token_required" },
    });

    const invalid = await f.target.func({ doc: "a", value: 1, proof_token: "bad" });

    expect(invalid.warning?.code).toBe("token_invalid");
    expect(f.calls()).toBe(2);

    const good = await f.source.func({ doc: "a" });

    expect(
      (await f.target.func({ doc: "a", value: 1, proof_token: proofOf(good) })).warning,
    ).toBeUndefined();
  });

  it("rejects repeated steps without an allowed retry", async () => {
    const f = setup();
    const start = await f.source.func({ doc: "a" });
    const done = await f.target.func({ doc: "a", value: 1, proof_token: proofOf(start) });

    await expect(
      f.target.func({ doc: "a", value: 1, proof_token: proofOf(done) }),
    ).rejects.toMatchObject({ code: "step_out_of_order" });
    expect(f.calls()).toBe(1);
  });

  it("refreshes envelopes without reviving expired dependencies", async () => {
    const f = setup({ ttl: 1, grace: 10 });
    const start = await f.source.func({ doc: "a" });

    f.clock.time = 102;
    await expect(f.flow.status({ proof_token: proofOf(start) })).rejects.toMatchObject({
      code: "token_expired",
    });

    const refreshed = await f.flow.refresh({ proof_token: proofOf(start) });

    expect(refreshed.next).toEqual([{ tool: "source", inputs: {} }]);
    expect(refreshed.evidence.source?.expiresAt).toBe(101);
    await expect(
      f.target.func({ doc: "a", value: 1, proof_token: refreshed.proof_token }),
    ).rejects.toMatchObject({ code: "dependency_expired" });
    f.clock.time = 112;
    await expect(f.flow.refresh({ proof_token: proofOf(start) })).rejects.toMatchObject({
      code: "token_expired",
    });
  });

  it("issues each step's lifetime after its handler finishes", async () => {
    let time = 100;
    const flow = baton({ name: "slow", secret, now: () => time });

    const step = flow
      .step("slow", { ttl: 5 })
      .description("Slow operation")
      .func(async () => {
        time = 200;

        return "done";
      });

    const done = await step.func({});

    expect(claimsOf(proofOf(done))).toMatchObject({ iat: 200, exp: 205 });
    expect((await flow.status({ proof_token: proofOf(done) })).expires_in).toBe(5);
  });

  it("refuses proofs missing a declared prerequisite or linked value", async () => {
    const f = setup();
    const selected = proofOf(await f.source.func({ doc: "a" }));
    const missingParent = resign(selected, (c) => {
      c.evidence = {};
    });

    expect((await f.flow.status({ proof_token: missingParent })).next).toEqual([]);
    await expect(
      f.target.func({ doc: "a", value: 1, proof_token: missingParent }),
    ).rejects.toMatchObject({ code: "dependency_required" });

    const missingValue = resign(selected, (c) => {
      const e = c.evidence.source;

      if (e) {
        e.values = {};
      }
    });

    await expect(
      f.target.func({ doc: "a", value: 1, proof_token: missingValue }),
    ).rejects.toMatchObject({ code: "dependency_required" });

    const missingForStatus = await f.flow.status({ proof_token: missingValue });

    expect(missingForStatus.next).toEqual([{ tool: "target", inputs: {} }]);
  });

  it("refuses a token whose allowed tool is absent from the graph", async () => {
    const f = setup();
    const selected = proofOf(await f.source.func({ doc: "a" }));

    await expect(
      f.flow.status({
        proof_token: resign(selected, (c) => {
          c.next = ["missing"];
        }),
      }),
    ).rejects.toMatchObject({ code: "token_invalid" });
  });

  it("rejects conflicting evidence from forks while accepting repeated identical proof", async () => {
    const f = setup();
    const selected = proofOf(await f.source.func({ doc: "a" }));

    const different = resign(selected, (c) => {
      const e = c.evidence.source;

      if (e) {
        e.values["0"] = "b";
      }
    });

    await expect(f.flow.status({ proof_token: [selected, different] })).rejects.toMatchObject({
      code: "dependency_conflict",
    });
    expect((await f.flow.status({ proof_token: [selected, selected] })).completed).toEqual([
      "source",
    ]);
  });

  it("turns non-JSON linked inputs into an input mismatch without running the handler", async () => {
    const f = setup();
    const selected = proofOf(await f.source.func({ doc: "a" }));
    const values = [undefined, new Date(), Number.POSITIVE_INFINITY];

    for (const value of values) {
      await expect(
        Reflect.apply(f.target.func, null, [{ doc: "a", value, proof_token: selected }]),
      ).rejects.toMatchObject({ code: "input_mismatch" });
    }

    expect(f.calls()).toBe(0);
  });

  it("preserves ordinary errors thrown while reading inputs or running application code", async () => {
    const f = setup();
    const selected = proofOf(await f.source.func({ doc: "a", value: { count: 1 } }));

    const value = Object.defineProperty({}, "count", {
      enumerable: true,

      get() {
        throw new Error("getter broke");
      },
    });

    await expect(f.target.func({ doc: "a", value, proof_token: selected })).rejects.toThrow(
      "getter broke",
    );

    const flow = baton({ name: "throws", secret });

    const throwing = flow
      .step("throws")
      .description("Application error")
      .func(() => {
        throw new Error("app broke");
      });

    await expect(throwing.func({})).rejects.toThrow("app broke");
  });

  it.each([
    ["undefined", undefined],
    ["infinite number", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["function", () => 1],
    ["class instance", new Date()],
    ["array with a hole", Array(1)],
  ])("refuses %s as selected output data", async (_label, value) => {
    const flow = baton({ name: "bad-output", secret });

    const start = flow
      .step("start")
      .description("Produce data")
      .func(() => value);

    Reflect.apply(start.output, null, [(result: unknown) => result]);
    await expect(start.func({})).rejects.toMatchObject({ code: "output_invalid" });
  });

  it("refuses cyclic selected output while allowing repeated references to acyclic data", async () => {
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    const flow = baton({ name: "cycle", secret });

    const source = flow
      .step("source")
      .description("Produce cycle")
      .func(() => cyclic);

    Reflect.apply(source.output, null, [(result: unknown) => result]);
    await expect(source.func({})).rejects.toMatchObject({ code: "output_invalid" });

    const shared = { count: 1 };
    const f = setup();
    const selected = await f.source.func({ doc: "a", value: [shared, shared] });

    expect(selected.next[0]?.inputs.value).toEqual([{ count: 1 }, { count: 1 }]);
  });

  it("selects only requested values rather than putting entire outputs in the token", async () => {
    const flow = baton({ name: "selected", secret });

    const source = flow
      .step("source")
      .description("Produce private and public fields")
      .func(() => ({ public: "yes", private: "secret data" }));

    flow
      .step("target", { from: { public: source.output((result) => result.public) } })
      .description("Use public field")
      .func((args: { public: string }) => args.public);

    const result = await source.func({});

    expect(JSON.stringify(claimsOf(proofOf(result)))).not.toContain("secret data");
  });
});

describe("graph lifetime and JavaScript boundary checks", () => {
  it.each(["", "with.dot", "with space", "arrow>name"])("rejects invalid flow name %j", (name) => {
    expect(() => baton({ name, secret })).toThrow("names must contain");
  });
  it("rejects invalid namespace and duration configuration", () => {
    expect(() => baton({ name: "ok", secret, namespace: "bad.name" })).toThrow(
      "names must contain",
    );

    for (const grace of [-1, 0.5, Number.NaN]) {
      expect(() => baton({ name: "ok", secret, grace })).toThrow("grace");
    }

    const flow = baton({ name: "ok", secret, grace: 0 });

    for (const ttl of [0, -1, 1.5]) {
      expect(() => flow.step("step", { ttl })).toThrow("ttl");
    }
  });
  it("seals declarations when calls begin and retains callable finished handles", async () => {
    const flow = baton({ name: "seal", secret });
    const view = flow.step("source");
    const described = view.description("Start");
    const source = described.func(() => "done");

    expect(() => Reflect.apply(view.description, null, ["changed"])).toThrow("finished");
    expect(() => Reflect.apply(described.func, null, [() => "second"])).toThrow("one handler");
    expect(() => view.dependsOn(source)).toThrow("finished");

    const result = await source({});

    expect(result.result).toBe("done");
    expect(() => flow.step("later")).toThrow("before calling tools");
    expect(() => source.output((result) => result)).toThrow("before calling tools");
    expect(() => source.branch({ when: () => true, pass: source, fail: source })).toThrow(
      "before calling tools",
    );
  });
  it("rejects duplicate names, unfinished graphs, missing descriptions, and invalid handlers", async () => {
    const flow = baton({ name: "definitions", secret });
    const builder = flow.step("source");

    expect(() => flow.step("source")).toThrow("already declared");
    expect(() => Reflect.apply(builder.func, null, [() => 1])).toThrow("description");
    expect(() => builder.description(" ")).toThrow("nonempty");

    const described = builder.description("Start");

    expect(() => Reflect.apply(described.func, null, [123])).toThrow("handler");

    const source = described.func(() => 1);

    flow.step("unfinished");
    await expect(source.func({})).rejects.toThrow("finish defining unfinished");

    const empty = baton({ name: "empty", secret });

    await expect(empty.status({ proof_token: "bad" })).rejects.toThrow("at least one step");
  });
  it("requires valid finished references for dependencies, outputs, and routes", () => {
    const flow = baton({ name: "refs", secret });

    const source = flow
      .step("source")
      .description("Start")
      .func(() => 1);

    const builder = flow.step("target");

    expect(() => Reflect.apply(builder.dependsOn, null, [])).toThrow("at least one");
    expect(() => Reflect.apply(builder.dependsOn, null, ["source"])).toThrow("finished steps");
    expect(() => Reflect.apply(source.output, null, ["field"])).toThrow("selector");
    expect(() =>
      Reflect.apply(flow.step, null, ["bad-from", { from: { value: "source" } }]),
    ).toThrow("output selectors");
    expect(() =>
      Reflect.apply(flow.step, null, [
        "reserved",
        { from: { proof_token: source.output((value) => value) } },
      ]),
    ).toThrow("reserved");

    const other = baton({ name: "other", secret });

    const unrelated = other
      .step("source")
      .description("Other")
      .func(() => 1);

    expect(() => Reflect.apply(builder.dependsOn, null, [unrelated])).toThrow("this flow");
    expect(() =>
      Reflect.apply(flow.step, null, [
        "wrong-owner",
        { from: { value: unrelated.output((value) => value) } },
      ]),
    ).toThrow("this flow");
    expect(() =>
      Reflect.apply(source.branch, null, [{ when: null, pass: source, fail: source }]),
    ).toThrow("predicate");
    expect(() =>
      Reflect.apply(source.branch, null, [{ when: () => true, pass: "source", fail: source }]),
    ).toThrow("finished steps");
  });
  it("requires prerequisites for an explicitly locked step even in JavaScript", () => {
    const flow = baton({ name: "locked", secret });
    const builder = flow.step("target", { locked: true }).description("Locked");

    expect(() => Reflect.apply(builder.func, null, [() => 1])).toThrow("prerequisite");
  });
  it("refuses invalid call argument objects", async () => {
    const flow = baton({ name: "args", secret });

    const start = flow
      .step("start")
      .description("Start")
      .func(() => 1);

    await expect(Reflect.apply(start.func, null, [null])).rejects.toThrow(
      "arguments must be an object",
    );
  });
  it("requires schema attachment and rejects application proof fields or missing linked inputs", () => {
    const flow = zodBaton({ name: "schema", secret, mcp: true });
    const first = flow.step("source").description("Start");

    expect(() => Reflect.apply(first.func, null, [() => ({ content: [] })])).toThrow("schema");
    expect(() => Reflect.apply(first.schema, null, [null])).toThrow("without proof_token");
    expect(() => Reflect.apply(first.schema, null, [{ proof_token: z.string() }])).toThrow(
      "without proof_token",
    );

    const shaped = first.schema({});

    expect(shaped.description).toContain("Start");
    expect(shaped.schema).toHaveProperty("proof_token");

    const source = shaped.func(() => ({ content: [], structuredContent: { count: 1 } }));

    expect(() => Reflect.apply(first.schema, null, [{}])).toThrow("finished");

    const child = flow.step("child", {
      from: { count: source.output((result) => result.structuredContent.count) },
    });

    expect(() => Reflect.apply(child.schema, null, [{}])).toThrow("linked input count");
  });
  it("checks route predicates and allows only one routing declaration per source", async () => {
    const flow = baton({ name: "routes", secret });

    const source = flow
      .step("start")
      .description("Start")
      .func(() => 1);

    const end = flow
      .step("end")
      .dependsOn(source)
      .description("End")
      .func(() => 2);

    Reflect.apply(source.branch, null, [{ when: () => "yes", pass: end, fail: source }]);
    expect(() => source.branch({ when: () => true, pass: end, fail: source })).toThrow("one route");
    await expect(source.func({})).rejects.toThrow("boolean");
  });
  it("invalidates descendants on routed retries, including shared descendants", async () => {
    const flow = baton({ name: "retry", secret });

    const read = flow
      .step("read")
      .description("Read")
      .func(() => "rules");

    const save = flow
      .step("save")
      .dependsOn(read)
      .description("Save")
      .func((args: { text: string }) => args.text);

    const check = flow
      .step("check", { from: { text: save.output((text) => text) } })
      .description("Check")
      .func((args: { text: string }) => ({ text: args.text, passed: args.text.length > 4 }));

    const finish = flow
      .step("finish")
      .dependsOn(save, check)
      .description("Finish")
      .func(() => "done");

    check.branch({ when: (result) => result.passed, pass: finish, fail: save });

    const r = await read.func({});
    const s = await save.func({ text: "bad", proof_token: proofOf(r) });
    const c = await check.func({ text: "bad", proof_token: proofOf(s) });

    await expect(finish.func({ proof_token: proofOf(c) })).rejects.toMatchObject({
      code: "step_out_of_order",
    });

    const retry = await save.func({ text: "good text", proof_token: proofOf(c) });

    expect(Object.keys(claimsOf(proofOf(retry)).evidence)).toEqual(["read", "save"]);

    const checked = await check.func({ text: "good text", proof_token: proofOf(retry) });

    expect((await finish.func({ proof_token: proofOf(checked) })).result).toBe("done");
  });
});

describe("MCP result boundaries", () => {
  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

  it("preserves application error results and never certifies failed handlers", async () => {
    const flow = baton({ name: "errors", secret, mcp: true });
    const error = { isError: true, content: [{ type: "text" as const, text: "app error" }] };

    const start = flow
      .step("start")
      .description("Start")
      .func(() => error);

    expect(await start.func({})).toEqual(error);
  });
  it("returns warnings for explicitly unlocked MCP calls without evidence", async () => {
    const flow = baton({ name: "warning", secret, mcp: true });

    const source = flow
      .step("source")
      .description("Source")
      .func(() => result("source"));

    const target = flow
      .step("target", { locked: false })
      .dependsOn(source)
      .description("Advisory")
      .func(() => result("ran"));

    const response = await target.func({});

    expect(response.content).toContainEqual({
      type: "text",
      text: expect.stringMatching(/^Warning: token_required:/),
    });
  });
  it("refuses non-MCP handler returns even when JavaScript bypasses types", async () => {
    const flow = baton({ name: "bad-mcp", secret, mcp: true });
    const builder = flow.step("start").description("Start");
    const start = Reflect.apply(builder.func, null, [() => "not MCP"]);

    await expect(start.func({})).rejects.toThrow("content array");
  });
});

describe("routed proof renewal", () => {
  it("recomputes permitted branches while keeping route proof deadlines", async () => {
    let time = 100;
    const flow = baton({ name: "route-expiry", secret, now: () => time });

    const start = flow
      .step("start", { ttl: 1 })
      .description("Start")
      .func(() => true);

    const pass = flow
      .step("pass")
      .dependsOn(start)
      .description("Pass")
      .func(() => "passed");

    const fail = flow
      .step("fail")
      .dependsOn(start)
      .description("Fail")
      .func(() => "failed");

    start.branch({ when: (result) => result, pass, fail });

    const selected = await start.func({});
    const fresh = await flow.refresh({ proof_token: proofOf(selected) });

    expect(fresh.next).toEqual([{ tool: "pass", inputs: {} }]);
    time = 102;

    const expired = await flow.refresh({ proof_token: fresh.proof_token });

    expect(expired.next).toEqual([{ tool: "start", inputs: {} }]);
    await expect(Reflect.apply(flow.status, null, [null])).rejects.toMatchObject({
      code: "token_required",
    });
  });
});

describe("current status", () => {
  it("does not advertise a call whose dependency expired after the token was issued", async () => {
    let time = 100;
    const flow = baton({ name: "status-expiry", secret, now: () => time });

    const root = flow
      .step("root", { ttl: 1 })
      .description("Root")
      .func(() => "rules");

    const first = flow
      .step("first")
      .dependsOn(root)
      .description("First")
      .func(() => "first");

    flow
      .step("second")
      .dependsOn(root)
      .description("Second")
      .func(() => "second");

    const r = await root.func({});
    const f = await first.func({ proof_token: proofOf(r) });

    expect(f.next.map((item) => item.tool)).toEqual(["second"]);
    time = 102;

    const status = await flow.status({ proof_token: proofOf(f) });

    expect(status.next).toEqual([]);
    expect(status.evidence.root?.expiresAt).toBe(101);
  });
});

describe("signed route constraints", () => {
  it("does not let a later route override another prerequisite's rejected branch", async () => {
    const flow = baton({ name: "route-constraints", secret });

    const start = flow
      .step("start")
      .description("Start")
      .func(() => "start");

    const test = flow
      .step("test")
      .dependsOn(start)
      .description("Check")
      .func(() => ({ passed: false }));

    const fix = flow
      .step("fix")
      .dependsOn(start)
      .description("Fix")
      .func(() => true);

    let published = 0;

    const close = flow
      .step("close")
      .dependsOn(test, fix)
      .description("Close")
      .func(() => {
        published++;

        return "closed";
      });

    test.branch({ when: (result) => result.passed, pass: close, fail: fix });
    fix.branch({ when: (result) => result, pass: close, fail: start });

    const begun = await start.func({});
    const failed = await test.func({ proof_token: proofOf(begun) });
    const fixed = await fix.func({ proof_token: proofOf(failed) });

    expect((await flow.status({ proof_token: proofOf(fixed) })).next).toEqual([]);
    await expect(close.func({ proof_token: proofOf(fixed) })).rejects.toMatchObject({
      code: "step_out_of_order",
    });
    expect(published).toBe(0);
  });
});

describe("expired prerequisite recovery", () => {
  it("does not call a blocked selected path finished when its prerequisite expires during a handler", async () => {
    let time = 100;
    const flow = baton({ name: "long-handler", secret, mcp: true, now: () => time });
    const reply = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

    const start = flow
      .step("start", { ttl: 1 })
      .description("Start")
      .func(() => reply("start"));

    const first = flow
      .step("first")
      .dependsOn(start)
      .description("Long operation")
      .func(() => {
        time = 102;

        return reply("first");
      });

    flow
      .step("final")
      .dependsOn(start, first)
      .description("Finish")
      .func(() => reply("final"));

    const initial = await start.func({});

    const token = initial.content
      .map((block) => ("text" in block ? block.text : ""))
      .join("\n")
      .match(/proof_token: (\S+)/)?.[1];

    const result = await first.func({ proof_token: token });
    const text = result.content.map((block) => ("text" in block ? block.text : "")).join("\n");

    expect(text).not.toContain("This flow is finished.");
    expect(text).toContain("Next: start");
  });
});

describe("tree completion", () => {
  it("finishes the selected leaf without requiring the unselected subtree", async () => {
    let time = 100;
    const flow = baton({ name: "tree-completion", secret, now: () => time });

    const root = flow
      .step("root", { ttl: 1 })
      .description("Choose a path")
      .func(() => true);

    const chosen = flow
      .step("chosen", { ttl: 1 })
      .dependsOn(root)
      .description("Chosen leaf")
      .func(() => "done");

    flow
      .step("unselected")
      .dependsOn(root)
      .description("Unselected subtree")
      .func(() => "not called");
    root.branch({ when: (value) => value, pass: chosen, fail: chosen });

    const start = await root.func({});
    const done = await chosen.func({ proof_token: proofOf(start) });

    expect(done.next).toEqual([]);
    expect((await flow.refresh({ proof_token: proofOf(done) })).next).toEqual([]);
    time = 102;
    expect((await flow.refresh({ proof_token: proofOf(done) })).next).toEqual([
      { tool: "root", inputs: {} },
    ]);
  });

  it("does not invent a branch when signed route evidence has no chosen target", async () => {
    const flow = baton({ name: "missing-route", secret });

    const root = flow
      .step("root")
      .description("Root")
      .func(() => true);

    const leaf = flow
      .step("leaf")
      .dependsOn(root)
      .description("Leaf")
      .func(() => "done");

    root.branch({ when: (value) => value, pass: leaf, fail: leaf });

    const start = await root.func({});

    const incomplete = resign(proofOf(start), (claims) => {
      const evidence = claims.evidence.root;

      if (evidence !== undefined) {
        delete evidence.next;
      }
    });

    expect((await flow.refresh({ proof_token: incomplete })).next).toEqual([]);
  });
});

describe("invocation isolation", () => {
  it("keeps selected values isolated when handlers finish in the opposite order", async () => {
    const flow = baton({ name: "concurrent", secret });
    const resolvers = new Map<string, () => void>();
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });

    const source = flow
      .step("source")
      .description("Read concurrently")
      .func(async ({ id }: { id: string }) => {
        await new Promise<void>((resolve) => {
          resolvers.set(id, resolve);

          if (resolvers.size === 2 && announceStarted !== undefined) {
            announceStarted();
          }
        });

        return { id };
      });

    flow
      .step("target", { from: { id: source.output((result) => result.id) } })
      .description("Use the selected identifier")
      .func(({ id }: { id: string }) => id);

    const a = source.func({ id: "a" });
    const b = source.func({ id: "b" });

    await started;

    const releaseB = resolvers.get("b");
    const releaseA = resolvers.get("a");

    if (releaseA === undefined || releaseB === undefined) {
      throw new Error("Both handlers must start");
    }

    releaseB();

    const second = await b;

    releaseA();

    const first = await a;

    expect(first.next).toEqual([{ tool: "target", inputs: { id: "a" } }]);
    expect(second.next).toEqual([{ tool: "target", inputs: { id: "b" } }]);
    expect(claimsOf(proofOf(first)).run).not.toBe(claimsOf(proofOf(second)).run);
  });

  it("allows a plain handler to return undefined without losing its completion proof", async () => {
    const flow = baton({ name: "undefined-result", secret });

    const source = flow
      .step("source")
      .description("Complete without a business result")
      .func(() => undefined);

    const response = await source.func({});

    expect(response.result).toBeUndefined();
    expect(response.next).toEqual([]);
    expect(proofOf(response)).toMatch(/^bt1\./);
  });

  it("rejects a second schema attached through a stale initial builder", () => {
    const flow = zodBaton({ name: "schema-alias", secret, mcp: true });
    const initial = flow.step("tool");

    initial.schema({ doc: z.string() });
    expect(() => initial.schema({ count: z.number() })).toThrow(/schema.*already|already.*schema/i);
  });
});

describe("validated argument snapshot", () => {
  it("passes the same stripped input snapshot to authorization and the handler", async () => {
    const f = setup();
    const selected = await f.source.func({ doc: "a" });
    let reads = 0;

    const args = {
      get doc() {
        reads++;

        return reads === 1 ? "a" : "b";
      },

      value: 1,
      proof_token: proofOf(selected),
    };

    const completed = await f.target.func(args);

    expect(completed.result.doc).toBe("a");
    expect(reads).toBe(1);
  });
});

describe("self-loop branches", () => {
  it("preserves an explicit self-loop when a still-valid proof is refreshed", async () => {
    const flow = baton({ name: "polling", secret });
    let done = false;

    const poll = flow
      .step("poll")
      .description("Poll until ready")
      .func(() => ({ done }));

    const finish = flow
      .step("finish")
      .dependsOn(poll)
      .description("Finish")
      .func(() => "finished");

    poll.branch({ when: (result) => result.done, pass: finish, fail: poll });

    const first = await poll.func({});

    expect(first.next).toEqual([{ tool: "poll", inputs: {} }]);

    const refreshed = await flow.refresh({ proof_token: proofOf(first) });

    expect(refreshed.next).toEqual([{ tool: "poll", inputs: {} }]);
    done = true;

    const ready = await poll.func({ proof_token: refreshed.proof_token });

    expect(ready.next).toEqual([{ tool: "finish", inputs: {} }]);
    expect((await finish.func({ proof_token: proofOf(ready) })).result).toBe("finished");
  });
});

describe("builder phase ordering", () => {
  it("keeps plain builder metadata usable before binding and accepts ordering after description", async () => {
    const flow = baton({ name: "plain-phases", secret });
    const initial = flow.step("source");

    expect(initial.name).toBe("source");

    const described = initial.description("Read");

    expect(described.name).toBe("source");
    expect(described.description).toContain("Read");

    const source = described.func(() => 1);
    const target = flow.step("target").description("Write").dependsOn(source);

    expect(target.name).toBe("target");
    expect(target.description).toContain("source");

    const bound = target.func(() => 2);
    const first = await source.func({});

    expect((await bound.func({ proof_token: proofOf(first) })).result).toBe(2);
  });

  it("accepts all supported schema, description, and prerequisite orders", async () => {
    const flow = zodBaton({ name: "zod-phases", secret, mcp: true });
    const bare = flow.step("source");

    expect(bare.name).toBe("source");
    expect(() => Reflect.get(bare, "func")).toThrow("description");

    const shaped = bare.schema({});

    expect(() => Reflect.get(shaped, "func")).toThrow("description");

    const source = shaped
      .description("Read")
      .func(() => ({ content: [{ type: "text" as const, text: "read" }] }));
    const described = flow.step("a").description("A").dependsOn(source);

    expect(described.name).toBe("a");
    expect(described.description).toContain("source");

    const a = described.schema({}).func(() => ({ content: [] }));

    const b = flow
      .step("b")
      .schema({})
      .dependsOn(source)
      .description("B")
      .func(() => ({ content: [] }));

    const ready = flow.step("c").description("C").schema({}).dependsOn(source);

    expect(ready.description).toContain("source");

    const c = ready.func(() => ({ content: [] }));

    const tokenFrom = (response: { content: { type: "text"; text: string }[] }): string => {
      const value = response.content
        .map((block) => block.text)
        .join("\n")
        .match(/proof_token: (\S+)/)?.[1];

      if (value === undefined) {
        throw new Error("Expected proof");
      }

      return value;
    };

    let current = tokenFrom(await source.func({}));

    current = tokenFrom(await a.func({ proof_token: current }));
    current = tokenFrom(await b.func({ proof_token: current }));
    current = tokenFrom(await c.func({ proof_token: current }));
    expect((await flow.status({ proof_token: current })).structuredContent).toMatchObject({
      completed: ["source", "a", "b", "c"],
    });
    expect((await flow.list({ proof_token: current })).structuredContent).toMatchObject({
      entries: ["source"],
    });
    expect((await flow.refresh({ proof_token: current })).structuredContent).toMatchObject({
      proof_token: expect.stringMatching(/^bt1\./),
    });
  });

  it("uses the Zod adapter with plain replies and MCP-formatted meta tools", async () => {
    const flow = zodBaton({ name: "zod-plain", secret });

    const read = flow
      .step("read")
      .schema({ doc: z.string() })
      .description("Read")
      .func(({ doc }) => ({ doc }));

    const write = flow
      .step("write", { from: { doc: read.output((result) => result.doc) } })
      .description("Write")
      .schema({ doc: z.string() })
      .func(({ doc }) => doc);

    const first = await read.func({ doc: "README.md" });
    const last = await write.func({ doc: "README.md", proof_token: proofOf(first) });

    expect(last.result).toBe("README.md");
    expect((await flow.status({ proof_token: proofOf(last) })).completed).toEqual([
      "read",
      "write",
    ]);
    expect((await flow.list({ proof_token: proofOf(last) })).entries).toEqual(["read"]);
    expect((await flow.refresh({ proof_token: proofOf(last) })).next).toEqual([]);

    for (const tool of flow.metaTools()) {
      expect((await tool.func({ proof_token: proofOf(last) })).isError).not.toBe(true);
    }
  });

  it("formats all core MCP meta endpoints and preserves configuration errors", async () => {
    const flow = baton({ name: "core-mcp-meta", secret, mcp: true });

    const source = flow
      .step("source")
      .description("Read")
      .func(() => ({ content: [{ type: "text" as const, text: "read" }] }));

    const response = await source.func({});

    const value = response.content
      .map((block) => block.text)
      .join("\n")
      .match(/proof_token: (\S+)/)?.[1];

    if (value === undefined) {
      throw new Error("Expected proof");
    }

    expect((await flow.status({ proof_token: value })).structuredContent).toMatchObject({
      completed: ["source"],
    });
    expect((await flow.list({ proof_token: value })).structuredContent).toMatchObject({
      entries: ["source"],
    });
    expect((await flow.refresh({ proof_token: value })).structuredContent).toMatchObject({
      proof_token: expect.stringMatching(/^bt1\./),
    });

    const empty = baton({ name: "empty-mcp-meta", secret, mcp: true });

    await expect(empty.status({ proof_token: "bad" })).rejects.toThrow("at least one step");
  });
});
