import type { FlowGraph, NextStep } from "./flow-contract.ts";
import type { RecordStep } from "./step-record.ts";
import { BatonError, type Evidence, type JsonValue } from "./token.ts";

export interface ExecutionGraph {
  entrySteps(): RecordStep[];

  guidance(): string;

  locked(step: RecordStep): boolean;

  children(step: RecordStep): RecordStep[];

  snapshot(): FlowGraph;

  required(step: RecordStep, evidence: Record<string, Evidence>, time: number): void;

  ready(step: RecordStep, evidence: Record<string, Evidence>, time: number): boolean;

  frontier(evidence: Record<string, Evidence>, time: number): string[];

  continuation(evidence: Record<string, Evidence>, time: number): string[];

  next(names: readonly string[], evidence: Record<string, Evidence>): NextStep[];

  invalidate(source: RecordStep, evidence: Record<string, Evidence>): Record<string, Evidence>;

  describe(step: RecordStep): string;

  lookup(name: string): RecordStep;
}

export const createGraph = (
  records: ReadonlyMap<string, RecordStep>,
  name: string,
): ExecutionGraph => {
  const lookup = (name: string): RecordStep => {
    const step = records.get(name);

    if (step === undefined) {
      throw new BatonError(
        "token_invalid",
        `This token names an unknown tool. Call ${guidance()}.`,
      );
    }

    return step;
  };

  const entrySteps = (): RecordStep[] =>
    [...records.values()].filter((step) => step.dependencies.size === 0);

  const guidance = (): string =>
    entrySteps()
      .map((step) => step.name)
      .join(" or ");

  const locked = (step: RecordStep): boolean => step.locked ?? step.dependencies.size > 0;
  const children = (source: RecordStep): RecordStep[] =>
    [...records.values()].filter((step) => step.dependencies.has(source));

  const graph = (): FlowGraph => ({
    flow: name,
    entries: entrySteps().map((step) => step.name),
    steps: [...records.values()].map((step) => ({
      tool: step.name,
      description: step.description,
      locked: locked(step),
      ttl: step.ttl,
      dependencies: [...step.dependencies].map((parent) => parent.name),
      next:
        step.route === null
          ? children(step).map((child) => child.name)
          : [step.route.pass.name, step.route.fail.name],
      branch:
        step.route === null ? null : { pass: step.route.pass.name, fail: step.route.fail.name },
      inputs: Object.fromEntries(
        [...step.links].map(([key, link]) => [key, { tool: link.source.name, output: link.id }]),
      ),
    })),
  });

  const required = (step: RecordStep, evidence: Record<string, Evidence>, time: number): void => {
    for (const parent of step.dependencies) {
      const proof = Object.hasOwn(evidence, parent.name) ? evidence[parent.name] : undefined;

      if (proof === undefined) {
        throw new BatonError(
          "dependency_required",
          `Call ${parent.name} before ${step.name}. Start with ${guidance()}.`,
        );
      }

      if (proof.expiresAt < time) {
        throw new BatonError(
          "dependency_expired",
          `Proof from ${parent.name} expired. Run ${parent.name} again; start with ${guidance()} if needed.`,
        );
      }

      if (parent.route !== null && !proof.next?.includes(step.name)) {
        throw new BatonError(
          "step_out_of_order",
          `The result from ${parent.name} did not allow ${step.name}. Follow its selected branch or restart with ${guidance()}.`,
        );
      }
    }
  };

  const ready = (step: RecordStep, evidence: Record<string, Evidence>, time: number): boolean => {
    for (const parent of step.dependencies) {
      const proof = Object.hasOwn(evidence, parent.name) ? evidence[parent.name] : undefined;

      if (
        proof === undefined ||
        proof.expiresAt < time ||
        (parent.route !== null && !proof.next?.includes(step.name))
      ) {
        return false;
      }
    }

    return true;
  };

  const frontier = (evidence: Record<string, Evidence>, time: number): string[] => {
    const result: string[] = [];

    for (const step of records.values()) {
      const previous = Object.hasOwn(evidence, step.name) ? evidence[step.name] : undefined;

      const routed = [...records.values()].some((source) => {
        const proof = Object.hasOwn(evidence, source.name) ? evidence[source.name] : undefined;

        return (
          source.route !== null &&
          proof !== undefined &&
          proof.next?.includes(step.name) === true &&
          proof.sequence >= (previous?.sequence ?? 0) &&
          proof.expiresAt >= time
        );
      });

      if (
        (step.dependencies.size > 0 || routed) &&
        (previous === undefined || previous.expiresAt < time || routed) &&
        ready(step, evidence, time)
      ) {
        result.push(step.name);
      }
    }

    return result;
  };

  const continuation = (evidence: Record<string, Evidence>, time: number): string[] => {
    const available = frontier(evidence, time);

    if (available.length > 0) {
      return available;
    }

    const pending = [...records.values()].some((source) => {
      const proof = Object.hasOwn(evidence, source.name) ? evidence[source.name] : undefined;

      if (proof === undefined) {
        return false;
      }

      const targets =
        source.route === null ? children(source).map((child) => child.name) : (proof.next ?? []);

      return targets.some((name) => {
        const previous = Object.hasOwn(evidence, name) ? evidence[name] : undefined;

        return (
          previous === undefined || (source.route !== null && proof.sequence >= previous.sequence)
        );
      });
    });

    return pending ? entrySteps().map((step) => step.name) : [];
  };

  const next = (names: readonly string[], evidence: Record<string, Evidence>): NextStep[] =>
    names.map((name) => {
      const step = lookup(name);

      const inputs: Record<string, JsonValue> = Object.fromEntries(
        [...step.links].flatMap(([key, link]) => {
          const proof = Object.hasOwn(evidence, link.source.name)
            ? evidence[link.source.name]
            : undefined;

          const value =
            proof !== undefined && Object.hasOwn(proof.values, link.id)
              ? proof.values[link.id]
              : undefined;

          return value === undefined ? [] : [[key, value]];
        }),
      );

      return { tool: name, inputs };
    });

  const invalidate = (
    source: RecordStep,
    evidence: Record<string, Evidence>,
  ): Record<string, Evidence> => {
    const removed = new Set<string>([source.name]);
    const pending = [source];

    for (const current of pending) {
      for (const child of children(current)) {
        if (!removed.has(child.name)) {
          removed.add(child.name);
          pending.push(child);
        }
      }
    }

    return Object.fromEntries(Object.entries(evidence).filter(([name]) => !removed.has(name)));
  };

  const describe = (step: RecordStep): string => {
    const message =
      step.dependencies.size === 0
        ? `Starts ${name}.`
        : `Needs the proof_token from ${[...step.dependencies].map((parent) => parent.name).join(" and ")}.`;

    return `${step.description} ${message}`;
  };

  return {
    entrySteps,
    guidance,
    locked,
    children,
    snapshot: graph,
    required,
    ready,
    frontier,
    continuation,
    next,
    invalidate,
    describe,
    lookup,
  };
};
