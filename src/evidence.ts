import {
  BatonError,
  type Claims,
  type Ctx,
  type Evidence,
  type JsonValue,
  verify,
} from "./token.ts";

export const json = (value: unknown, seen = new Set<object>()): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "object" || seen.has(value)) {
    throw new BatonError(
      "output_invalid",
      "Linked output values must be finite, acyclic JSON data.",
    );
  }

  seen.add(value);

  let result: JsonValue;

  if (Array.isArray(value)) {
    result = Array.from(value, (item) => json(item, seen));
  } else {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new BatonError("output_invalid", "Linked output values must be plain JSON objects.");
    }

    result = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, json(Reflect.get(value, key), seen)]),
    );
  }

  seen.delete(value);

  return result;
};

export const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(json(left)) === JSON.stringify(json(right));

export const readProofs = (
  input: unknown,
  ctx: Ctx,
  nextFor: (evidence: Record<string, Evidence>, time: number) => string[],
  allowance = 0,
): Claims => {
  const tokens: unknown[] = Array.isArray(input) ? input : [input];
  const first = verify(tokens[0], ctx, allowance);
  const verified = [first, ...tokens.slice(1).map((token) => verify(token, ctx, allowance))];
  const evidence = new Map<string, Evidence>();

  for (const claim of verified) {
    if (claim.run !== first.run) {
      throw new BatonError(
        "dependency_conflict",
        `These proofs belong to different runs. Start with ${ctx.start} and keep the proofs from that run.`,
      );
    }

    for (const [name, proof] of Object.entries(claim.evidence)) {
      if (evidence.has(name) && !equal(evidence.get(name), proof)) {
        throw new BatonError(
          "dependency_conflict",
          `These proofs disagree about ${name}. Use proofs from the same version of the work.`,
        );
      }

      evidence.set(name, proof);
    }
  }

  const merged = Object.fromEntries(evidence);

  return {
    ...first,
    evidence: merged,
    iat: Math.max(...verified.map((claim) => claim.iat)),
    exp: Math.min(...verified.map((claim) => claim.exp)),
    next: verified.length === 1 ? first.next : nextFor(merged, ctx.now),
  };
};
