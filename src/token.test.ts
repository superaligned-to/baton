import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BatonError, type Claims, type Ctx, checkSecret, hash, sign, verify } from "./token.ts";

const secret = "s".repeat(32);

const ctx: Ctx = {
  secret,
  flow: "release",
  graph: hash("release-graph"),
  start: "read_rules",
  refresh: "baton_refresh",
  now: 1000,
};

const evidence = {
  sequence: 1,
  issuedAt: 1000,
  expiresAt: 1300,
  values: { passed: true, count: 1 },
};

const claims: Claims = {
  flow: ctx.flow,
  graph: ctx.graph,
  run: "run-1",
  step: "test",
  next: ["publish"],
  evidence: { test: evidence },
  iat: 1000,
  exp: 1900,
};

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

const signedBody = (body: string): string =>
  `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;

const forge = (payload: unknown, header = "bt1.release.test>publish"): string =>
  signedBody(`${header}.${encode(payload)}`);

const signedJson = (json: string): string =>
  signedBody(`bt1.release.test>publish.${Buffer.from(json).toString("base64url")}`);

const invalid = (value: unknown, context: Ctx = ctx): void => {
  expect(() => verify(value, context)).toThrowError(
    expect.objectContaining({
      code: "token_invalid",
      message: expect.stringContaining("read_rules"),
    }),
  );
};

describe("signed dependency tokens", () => {
  const token = sign(secret, claims);

  it("round-trips signed dependency evidence with a readable route", () => {
    expect(verify(token, ctx)).toEqual(claims);
    expect(token).toMatch(/^bt1\.release\.test>publish\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  });

  it("carries selected JSON values and an optional branch decision", () => {
    const data: Claims = {
      ...claims,
      evidence: {
        test: {
          ...evidence,
          next: [],
          values: { nested: [null, false, "", 1, { files: ["README.md"] }] },
        },
      },
    };

    expect(verify(sign(secret, data), ctx)).toEqual(data);
  });

  it("supports multiple allowed tools, terminal routes, and dotted names", () => {
    const branching = { ...claims, next: ["fix", "publish"] };

    expect(sign(secret, branching)).toMatch(/^bt1\.release\.test>fix\|publish\./);
    expect(verify(sign(secret, branching), ctx)).toEqual(branching);

    const namedEnd = { ...claims, next: ["end"] };

    expect(sign(secret, namedEnd)).toMatch(/^bt1\.release\.test>end\./);
    expect(verify(sign(secret, namedEnd), ctx)).toEqual(namedEnd);

    const finished = { ...claims, next: [] };

    expect(sign(secret, finished)).toMatch(/^bt1\.release\.test>~\./);
    expect(verify(sign(secret, finished), ctx)).toEqual(finished);

    const dotted = { ...claims, flow: "release.docs", step: "test.all" };

    expect(verify(sign(secret, dotted), { ...ctx, flow: dotted.flow })).toEqual(dotted);
  });

  it("uses bytes rather than characters for the secret length", () => {
    const unicodeSecret = "é".repeat(16);

    expect(() => checkSecret(unicodeSecret)).not.toThrow();
    expect(verify(sign(unicodeSecret, claims), { ...ctx, secret: unicodeSecret })).toEqual(claims);
  });

  it.each(["", "x", "x".repeat(31)])("rejects a short secret %j", (key) => {
    expect(() => sign(key, claims)).toThrow("secret must be at least 32 bytes");
    expect(() => verify(token, { ...ctx, secret: key })).toThrow(TypeError);
  });

  it.each([undefined, null, ""])("requires a token for %j", (value) => {
    expect(() => verify(value, ctx)).toThrowError(
      expect.objectContaining({
        code: "token_required",
        message: expect.stringContaining("read_rules"),
      }),
    );
  });

  it.each([42, {}, [], "x", "bt1", "bt1.e30.sig", "bt1.f.a>b.e30."])(
    "rejects malformed input %j",
    (value) => invalid(value),
  );

  it("rejects an edited route, payload, flow segment, or signature", () => {
    invalid(token.replace("test>publish", "test>destroy"));
    invalid(token.replace("bt1.release.", "bt1.other."));

    const parts = token.split(".");

    parts[parts.length - 2] = encode({ ...claims, run: "another-run" });
    invalid(parts.join("."));
    invalid(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"));
    invalid(`${token}A`);
    invalid(token, { ...ctx, secret: "z".repeat(32) });
  });

  it("rejects an alternative base64 spelling of the same signature bytes", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = token.at(-1) as string;
    const alternate = token.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];

    expect(Buffer.from(alternate.split(".").at(-1) as string, "base64url")).toEqual(
      Buffer.from(token.split(".").at(-1) as string, "base64url"),
    );
    invalid(alternate);
  });

  it("rejects another protocol, flow, graph, and a future issuance time", () => {
    invalid(forge(claims, "bt2.release.test>publish"));
    invalid(sign(secret, { ...claims, flow: "other" }));
    invalid(sign(secret, { ...claims, graph: "other-graph" }));
    invalid(sign(secret, { ...claims, iat: 1001 }));
  });

  it("checks the displayed route against the signed payload", () => {
    invalid(forge(claims, "bt1.release.test>destroy"));
    invalid(forge(claims, "bt1.other.test>publish"));
    invalid(forge(claims, "bt1.release.other>publish"));
  });

  it("rejects noncanonical base64 and invalid JSON even with a valid MAC", () => {
    invalid(signedBody("bt1.release.test>publish.*"));
    invalid(signedBody("bt1.release.test>publish."));
    invalid(signedJson("not json"));
  });

  it.each([
    null,
    [],
    "claims",
    { ...claims, flow: 1 },
    { ...claims, flow: "" },
    { ...claims, graph: null },
    { ...claims, run: false },
    { ...claims, step: "" },
    { ...claims, next: "publish" },
    { ...claims, next: [1] },
    { ...claims, next: [""] },
    { ...claims, evidence: null },
    { ...claims, evidence: [] },
    { ...claims, iat: -1 },
    { ...claims, iat: 1.5 },
    { ...claims, iat: "1000" },
    { ...claims, iat: Number.MAX_SAFE_INTEGER + 1 },
    { ...claims, exp: 1000 },
    { ...claims, exp: 999 },
    { ...claims, exp: null },
    { ...claims, graph: undefined },
  ])("rejects a signed malformed envelope %j", (value) => invalid(forge(value)));

  it.each([
    null,
    [],
    "evidence",
    { ...evidence, sequence: 0 },
    { ...evidence, sequence: -1 },
    { ...evidence, sequence: 1.5 },
    { ...evidence, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...evidence, sequence: undefined },
    { ...evidence, issuedAt: -1 },
    { ...evidence, issuedAt: undefined },
    { ...evidence, issuedAt: 1001 },
    { ...evidence, expiresAt: 1000 },
    { ...evidence, expiresAt: 999 },
    { ...evidence, expiresAt: undefined },
    { ...evidence, values: [] },
    { ...evidence, values: null },
    { ...evidence, values: undefined },
    { ...evidence, next: null },
    { ...evidence, next: "publish" },
    { ...evidence, next: [1] },
  ])("rejects malformed dependency evidence %j", (value) => {
    invalid(forge({ ...claims, evidence: { test: value } }));
  });

  it("rejects empty evidence names and numeric overflow in selected output data", () => {
    invalid(forge({ ...claims, evidence: { "": evidence } }));
    invalid(signedJson(JSON.stringify(claims).replace('"count":1', '"count":1e999')));
  });

  it("does not inherit required envelope fields from prototypes", () => {
    const inherited = Object.create(claims) as object;

    invalid(forge(inherited));
  });

  it("preserves own record keys without changing object prototypes", () => {
    const withReservedKey = JSON.parse(
      JSON.stringify({ ...claims, evidence: { safe: evidence } }).replace(
        '"safe":',
        '"__proto__":',
      ),
    ) as Claims;

    const result = verify(sign(secret, withReservedKey), ctx);

    expect(Object.hasOwn(result.evidence, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.evidence)).toBe(Object.prototype);
    expect(Reflect.get(result.evidence, "__proto__")).toEqual(evidence);
    expect(Object.hasOwn(Object.prototype, "sequence")).toBe(false);
  });

  it("validates deeply nested JSON without recursive stack exhaustion", () => {
    const nested = signedJson(
      JSON.stringify(claims).replace(
        '"count":1',
        `"count":${"[".repeat(2000)}1${"]".repeat(2000)}`,
      ),
    );

    expect(verify(nested, ctx).run).toBe("run-1");
  });

  it("expires immediately after exp and accepts the exact expiry boundary", () => {
    expect(verify(token, { ...ctx, now: 1900 })).toEqual(claims);
    expect(() => verify(token, { ...ctx, now: 1901 })).toThrowError(
      expect.objectContaining({
        code: "token_expired",
        message: expect.stringContaining("baton_refresh"),
      }),
    );
  });

  it("allows authentic expired envelopes within grace without renewing their evidence", () => {
    expect(verify(token, { ...ctx, now: 1901 }, 60)).toEqual(claims);
    expect(verify(token, { ...ctx, now: 1960 }, 60).evidence.test?.expiresAt).toBe(1300);
    expect(() => verify(token, { ...ctx, now: 1961 }, 60)).toThrowError(
      expect.objectContaining({
        code: "token_expired",
        message: expect.stringContaining("read_rules"),
      }),
    );
    expect(() => verify(token, { ...ctx, now: 1961 }, 60)).toThrow(/too long ago/);
  });

  it("fails closed for invalid clocks and grace values", () => {
    expect(() => verify(token, { ...ctx, now: Number.NaN })).toThrowError(
      expect.objectContaining({ code: "token_expired" }),
    );
    expect(() => verify(token, { ...ctx, now: Number.POSITIVE_INFINITY })).toThrowError(
      expect.objectContaining({ code: "token_expired" }),
    );

    for (const grace of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => verify(token, ctx, grace)).toThrowError(
        expect.objectContaining({ code: "token_expired" }),
      );
    }
  });

  it("limits issued and received tokens to 65536 bytes", () => {
    expect(() =>
      sign(secret, {
        ...claims,
        evidence: { test: { ...evidence, values: { text: "x".repeat(65_536) } } },
      }),
    ).toThrow(RangeError);
    invalid(`bt1.${"x".repeat(65_536)}`);

    const smaller = sign(secret, {
      ...claims,
      evidence: { test: { ...evidence, values: { text: "x".repeat(40_000) } } },
    });

    expect(verify(smaller, ctx).run).toBe(claims.run);
  });

  it("BatonError exposes its stable name and code", () => {
    const error = new BatonError("input_mismatch", "Use the linked value.");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BatonError");
    expect(error.code).toBe("input_mismatch");
    expect(error.message).toBe("Use the linked value.");
  });

  it("hashes data deterministically with SHA-256", () => {
    expect(hash("a")).toBe(hash("a"));
    expect(hash("a")).not.toBe(hash("b"));
    expect(hash("a")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
