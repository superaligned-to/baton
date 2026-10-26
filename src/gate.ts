import { randomUUID } from "node:crypto";
import { equal, json, readProofs } from "./evidence.ts";
import type { Config, FlowGraph, ProofArguments, Status, TextResult } from "./flow-contract.ts";
import { createGraph } from "./graph.ts";
import type {
  Engine,
  Execution,
  Invocation,
  Output,
  RecordStep,
  RuntimeOptions,
} from "./step-record.ts";
import {
  BatonError,
  type Claims,
  type Ctx,
  checkSecret,
  type Evidence,
  hash,
  sign,
} from "./token.ts";

const handles = new WeakMap<object, { owner: object; step: RecordStep }>();
const outputs = new WeakMap<object, { owner: object; output: Output }>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: string): TextResult => ({ content: [{ type: "text", text: value }] });

const fail: (message: string) => never = (message) => {
  throw new TypeError(`baton: ${message}`);
};

const validName = (value: string): void => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail("names must contain only letters, numbers, underscores, or hyphens");
  }
};

const duration = (value: number, label: string, minimum = 1): number => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer of at least ${minimum} seconds`);
  }

  return value;
};

export const createEngine = <const Name extends string>(
  config: Config<Name, boolean>,
): Engine<Name> => {
  checkSecret(config.secret);
  validName(config.name);

  if (config.namespace !== undefined) {
    validName(config.namespace);
  }

  const grace = duration(config.grace ?? 86400, "grace", 0);
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const owner = {};
  const records = new Map<string, RecordStep>();
  const {
    entrySteps,
    guidance,
    locked,
    snapshot,
    required,
    ready,
    frontier,
    continuation,
    next,
    invalidate,
    describe,
    lookup,
  } = createGraph(records, config.name);

  const prefix = `baton_${config.namespace === undefined ? "" : `${config.namespace}_`}`;
  let sealed = false;
  let graphDigest = "";

  const mutable = (): void => {
    if (sealed) {
      fail("declare the complete flow before calling tools");
    }
  };

  const editable = (record: RecordStep, message: string): void => {
    mutable();

    if (record.bound) {
      fail(message);
    }
  };

  const context = (): Ctx => ({
    secret: config.secret,
    flow: config.name,
    graph: graphDigest,
    start: guidance(),
    refresh: `${prefix}refresh`,
    now: now(),
  });

  const resolve = (value: unknown): RecordStep => {
    const found = typeof value === "function" || isRecord(value) ? handles.get(value) : undefined;

    if (found === undefined || found.owner !== owner) {
      fail("dependencies and routes must reference finished steps from this flow");
    }

    return found.step;
  };

  const seal = (): void => {
    if (!sealed) {
      if (records.size === 0) {
        fail("define at least one step");
      }

      for (const step of records.values()) {
        if (!step.bound) {
          fail(`finish defining ${step.name} before calling tools`);
        }
      }

      graphDigest = hash(
        JSON.stringify({
          graph: snapshot(),
          selectors: [...records.values()].map((step) =>
            [...step.outputs].map(([id, selector]) => [step.name, id, String(selector)]),
          ),
          routes: [...records.values()].map((step) =>
            step.route === null ? null : String(step.route.when),
          ),
        }),
      );
      sealed = true;
    }
  };

  const read = (input: unknown, allowance = 0): Claims =>
    readProofs(input, context(), frontier, allowance);

  const refusal = (error: BatonError): TextResult => ({
    ...text(`${error.code}: ${error.message}`),
    isError: true,
  });

  const execute = async <Args extends object, Result, Failure extends object = never>(
    step: RecordStep,
    args: Args & ProofArguments,
    invoke: (inputs: Args) => Promise<Invocation<Result>>,
    failure?: (result: Result) => Failure | null,
  ): Promise<Execution<Result, Failure>> => {
    seal();

    if (!isRecord(args)) {
      fail("tool arguments must be an object");
    }

    const inputs: Args & ProofArguments & Record<string, unknown> = { ...args };
    const proofToken = inputs.proof_token;
    delete inputs.proof_token;

    let prior: Claims | null = null;
    let warning: BatonError | null = null;
    const checkedAt = now();

    try {
      if (proofToken !== undefined && proofToken !== null && proofToken !== "") {
        prior = read(proofToken);
        required(step, prior.evidence, checkedAt);

        if (!prior.next.includes(step.name)) {
          throw new BatonError(
            "step_out_of_order",
            `Call ${prior.next.join(" or ") || guidance()} with this proof_token before ${step.name}.`,
          );
        }
      } else if (step.dependencies.size > 0) {
        throw new BatonError(
          "token_required",
          `Call ${guidance()} first and pass the proof_token it returns to ${step.name}.`,
        );
      }

      if (prior !== null) {
        for (const [key, link] of step.links) {
          const proof = prior.evidence[link.source.name];

          if (proof === undefined || !Object.hasOwn(proof.values, link.id)) {
            throw new BatonError(
              "dependency_required",
              `Run ${link.source.name} again to supply ${key}.`,
            );
          }

          let matches = false;

          try {
            matches = equal(inputs[key], proof.values[link.id]);
          } catch (error) {
            if (!(error instanceof BatonError)) {
              throw error;
            }
          }

          if (!matches) {
            throw new BatonError(
              "input_mismatch",
              `${key} must match the value returned by ${link.source.name}. Call ${prefix}status with this proof_token if you need that value.`,
            );
          }
        }
      }
    } catch (error) {
      if (!(error instanceof BatonError)) {
        throw error;
      }

      if (locked(step)) {
        return { kind: "refusal", error };
      }

      prior = null;
      warning = error;
    }

    const invocation = await invoke(inputs);
    const result = invocation.result;
    const failed = failure?.(result);

    if (failed !== undefined && failed !== null) {
      return failed;
    }

    if (warning !== null) {
      return { kind: "warning", result, warning: { code: warning.code, message: warning.message } };
    }

    const time = now();
    const previous = prior?.evidence ?? {};
    const sequence = Math.max(0, ...Object.values(previous).map((proof) => proof.sequence)) + 1;
    const values = Object.fromEntries(invocation.values().map(([id, value]) => [id, json(value)]));
    const proof: Evidence = { sequence, issuedAt: time, expiresAt: time + step.ttl, values };
    const selected = invocation.selected();

    if (step.route !== null) {
      if (typeof selected !== "boolean") {
        fail("route predicates must return a boolean");
      }

      proof.next = [selected ? step.route.pass.name : step.route.fail.name];
    }

    const evidence = Object.fromEntries([
      ...Object.entries(invalidate(step, previous)),
      [step.name, proof],
    ]);

    const names = proof.next ?? continuation(evidence, time);

    const issued: Claims = {
      flow: config.name,
      graph: graphDigest,
      run: prior?.run ?? randomUUID(),
      step: step.name,
      next: names,
      evidence,
      iat: time,
      exp: time + step.ttl,
    };

    const token = sign(config.secret, issued);
    const steps = next(names, evidence);

    return { kind: "success", result, proof_token: token, next: steps };
  };

  const step = (name: string, options: RuntimeOptions = {}): RecordStep => {
    mutable();
    validName(name);

    if (records.has(name)) {
      fail(`step ${name} is already declared; reuse its handle`);
    }

    const record: RecordStep = {
      name,
      description: name,
      ttl: duration(options.ttl ?? 900, "ttl"),
      locked: options.locked,
      dependencies: new Set(),
      links: new Map(),
      outputs: new Map(),
      schema: null,
      bound: false,
      route: null,
    };

    for (const [key, reference] of Object.entries(options.from ?? {})) {
      if (key === "proof_token") {
        fail("proof_token is reserved for baton");
      }

      const found = isRecord(reference) ? outputs.get(reference) : undefined;

      if (found === undefined || found.owner !== owner) {
        fail("from needs output selectors from this flow");
      }

      record.links.set(key, found.output);
      record.dependencies.add(found.output.source);
    }

    records.set(name, record);

    return record;
  };

  const depend = (record: RecordStep, dependencies: unknown[]): void => {
    editable(record, "finished steps cannot change dependencies");

    if (dependencies.length === 0) {
      fail("dependsOn needs at least one finished step");
    }

    for (const dependency of dependencies) {
      record.dependencies.add(resolve(dependency));
    }
  };

  const description = (record: RecordStep, value: string): void => {
    editable(record, "finished steps cannot change descriptions");

    if (typeof value !== "string" || value.trim() === "") {
      fail("description must be a nonempty string");
    }

    record.description = value;
  };

  const schema = (record: RecordStep, shape: unknown, injected: Record<string, unknown>): void => {
    editable(record, "finished steps cannot change schemas");

    if (record.schema !== null) {
      fail("a schema is already attached to this step");
    }

    if (!isRecord(shape) || Object.hasOwn(shape, "proof_token")) {
      fail("pass your input shape without proof_token; baton injects it");
    }

    for (const key of record.links.keys()) {
      if (!Object.hasOwn(shape, key)) {
        fail(`linked input ${key} is missing from the schema`);
      }
    }

    record.schema = injected;
  };

  const bind = (record: RecordStep, handler: unknown): void => {
    editable(record, "a step can only bind one handler");

    if (locked(record) && record.dependencies.size === 0) {
      fail("a locked step needs a prerequisite");
    }

    if (typeof handler !== "function") {
      fail("func needs a handler");
    }

    record.bound = true;
  };

  const output = (
    record: RecordStep,
    reference: object,
    selector: { toString(): string },
  ): string => {
    mutable();

    if (typeof selector !== "function") {
      fail("output needs a selector function");
    }

    const id = String(record.outputs.size);

    record.outputs.set(id, selector);
    outputs.set(reference, { owner, output: { source: record, id } });

    return id;
  };

  const route = (
    record: RecordStep,
    branch: { when: { toString(): string }; pass: unknown; fail: unknown },
  ): void => {
    mutable();

    if (record.route !== null) {
      fail("a step can only declare one route");
    }

    if (typeof branch.when !== "function") {
      fail("route needs a predicate");
    }

    record.route = { when: branch.when, pass: resolve(branch.pass), fail: resolve(branch.fail) };
  };

  const statusData = (claims: Claims): Status => {
    const time = now();
    const announced = next(claims.next, claims.evidence);

    return {
      flow: config.name,
      run: claims.run,
      completed: Object.keys(claims.evidence),
      evidence: claims.evidence,
      next: announced.filter((item) => ready(lookup(item.tool), claims.evidence, time)),
      expires_in: Math.max(0, claims.exp - time),
    };
  };

  const readMeta = (args: ProofArguments, allowance = 0): Claims => {
    seal();

    return read(isRecord(args) ? args.proof_token : undefined, allowance);
  };

  const status = async (args: ProofArguments): Promise<Status> => statusData(readMeta(args));

  const graph = (): FlowGraph => {
    seal();

    return snapshot();
  };

  const list = async (args: ProofArguments): Promise<FlowGraph> => {
    readMeta(args);

    return snapshot();
  };

  const refresh = async (args: ProofArguments): Promise<Status & { proof_token: string }> => {
    const claims = readMeta(args, grace);
    const time = now();
    const names = continuation(claims.evidence, time);
    const refreshed: Claims = { ...claims, next: names, iat: time, exp: time + 900 };

    if (
      names.length === 0 &&
      Object.values(claims.evidence).some((proof) => proof.expiresAt < time)
    ) {
      refreshed.next = entrySteps().map((entry) => entry.name);
    }

    return { ...statusData(refreshed), proof_token: sign(config.secret, refreshed) };
  };

  const mcpMeta: Engine<Name>["mcpMeta"] = async (action) => {
    try {
      const data = await action();

      return { ...text(JSON.stringify(data)), structuredContent: { ...data } };
    } catch (error) {
      if (error instanceof BatonError) {
        return refusal(error);
      }

      throw error;
    }
  };

  return {
    name: config.name,
    prefix,
    step,
    depend,
    describe,
    description,
    schema,
    bind,
    output,
    route,
    handle: (record, handle) => {
      handles.set(handle, { owner, step: record });
    },
    execute,
    status,
    graph,
    list,
    refresh,
    mcpMeta,
  };
};
