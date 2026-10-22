import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "bt1";

const MAX_TOKEN_LENGTH = 65_536;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Evidence {
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  values: Record<string, JsonValue>;
  next?: string[];
}

export interface Claims {
  flow: string;
  graph: string;
  run: string;
  step: string;
  next: string[];
  evidence: Record<string, Evidence>;
  iat: number;
  exp: number;
}

export type ErrorCode =
  | "token_required"
  | "token_invalid"
  | "token_expired"
  | "dependency_required"
  | "dependency_expired"
  | "dependency_conflict"
  | "input_mismatch"
  | "step_out_of_order"
  | "output_invalid";

export class BatonError extends Error {
  override readonly name = "BatonError";

  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Ctx {
  secret: string;
  flow: string;
  graph: string;
  start: string;
  refresh: string;
  now: number;
}

const b64 = (value: Buffer): string => value.toString("base64url");

export const hash = (value: string): string => b64(createHash("sha256").update(value).digest());

export const checkSecret = (secret: string): void => {
  if (Buffer.byteLength(secret) < 32) {
    throw new TypeError("baton: secret must be at least 32 bytes");
  }
};

const mac = (secret: string, body: string): string => {
  checkSecret(secret);

  return b64(createHmac("sha256", secret).update(body).digest());
};

const header = (claims: Claims): string =>
  `${PREFIX}.${claims.flow}.${claims.step}>${claims.next.join("|") || "~"}`;

export const sign = (secret: string, claims: Claims): string => {
  const body = `${header(claims)}.${b64(Buffer.from(JSON.stringify(claims)))}`;
  const token = `${body}.${mac(secret, body)}`;

  if (Buffer.byteLength(token) > MAX_TOKEN_LENGTH) {
    throw new RangeError("baton: linked output values exceed the 65536-byte token limit");
  }

  return token;
};

const invalid = (ctx: Ctx): BatonError =>
  new BatonError(
    "token_invalid",
    `This token is not valid for ${ctx.flow}. Call ${ctx.start} to start again.`,
  );

const isRecord = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Record<string, JsonValue>, key: string): JsonValue | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const finiteJson = (value: JsonValue): boolean => {
  const pending = [value];

  while (pending.length > 0) {
    const item = pending.pop();

    if (typeof item === "number" && !Number.isFinite(item)) {
      return false;
    }

    if (item !== null && typeof item === "object") {
      pending.push(...Object.values(item));
    }
  }

  return true;
};

const parseEvidence = (raw: JsonValue): Evidence | null => {
  if (!isRecord(raw)) {
    return null;
  }

  const sequence = own(raw, "sequence");
  const issuedAt = own(raw, "issuedAt");
  const expiresAt = own(raw, "expiresAt");
  const values = own(raw, "values");
  const next = own(raw, "next");

  if (
    !isTime(sequence) ||
    sequence === 0 ||
    !isTime(issuedAt) ||
    !isTime(expiresAt) ||
    expiresAt <= issuedAt ||
    !isRecord(values) ||
    !Object.values(values).every(finiteJson) ||
    (next !== undefined && !isNames(next))
  ) {
    return null;
  }

  const result: Evidence = { sequence, issuedAt, expiresAt, values };

  if (next !== undefined) {
    result.next = next;
  }

  return result;
};

const parseClaims = (raw: JsonValue): Claims | null => {
  if (!isRecord(raw)) {
    return null;
  }

  const flow = own(raw, "flow");
  const graph = own(raw, "graph");
  const run = own(raw, "run");
  const step = own(raw, "step");
  const next = own(raw, "next");
  const evidence = own(raw, "evidence");
  const iat = own(raw, "iat");
  const exp = own(raw, "exp");

  if (
    !isString(flow) ||
    !isString(graph) ||
    !isString(run) ||
    !isString(step) ||
    !isNames(next) ||
    !isRecord(evidence) ||
    !isTime(iat) ||
    !isTime(exp) ||
    exp <= iat
  ) {
    return null;
  }

  const entries: [string, Evidence][] = [];

  for (const [name, value] of Object.entries(evidence)) {
    const parsed = parseEvidence(value);

    if (!isString(name) || parsed === null || parsed.issuedAt > iat) {
      return null;
    }

    entries.push([name, parsed]);
  }

  return { flow, graph, run, step, next, evidence: Object.fromEntries(entries), iat, exp };
};

const parseJson = (text: string): JsonValue => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const decode = (token: unknown, ctx: Ctx): Claims => {
  if (token === undefined || token === null || token === "") {
    throw new BatonError(
      "token_required",
      `Call ${ctx.start} first and pass the proof_token it returns.`,
    );
  }

  if (
    typeof token !== "string" ||
    Buffer.byteLength(token) > MAX_TOKEN_LENGTH ||
    !token.startsWith(`${PREFIX}.`)
  ) {
    throw invalid(ctx);
  }

  const end = token.lastIndexOf(".");
  const body = token.slice(0, end);
  const got = Buffer.from(token.slice(end + 1));
  const want = Buffer.from(mac(ctx.secret, body));

  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw invalid(ctx);
  }

  const separator = body.lastIndexOf(".");
  const payload = body.slice(separator + 1);
  const decoded = Buffer.from(payload, "base64url");

  if (b64(decoded) !== payload) {
    throw invalid(ctx);
  }

  const claims = parseClaims(parseJson(decoded.toString()));

  if (
    claims === null ||
    body.slice(0, separator) !== header(claims) ||
    claims.flow !== ctx.flow ||
    claims.graph !== ctx.graph ||
    claims.iat > ctx.now
  ) {
    throw invalid(ctx);
  }

  return claims;
};

export const verify = (token: unknown, ctx: Ctx, grace = 0): Claims => {
  const claims = decode(token, ctx);

  if (!(Number.isFinite(grace) && grace >= 0 && ctx.now <= claims.exp + grace)) {
    throw new BatonError(
      "token_expired",
      grace > 0
        ? `This token expired too long ago to refresh. Call ${ctx.start} to start ${ctx.flow} again.`
        : `This token expired. Call ${ctx.refresh} with it to continue.`,
    );
  }

  return claims;
};
