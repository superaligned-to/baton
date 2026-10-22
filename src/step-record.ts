import type { FlowGraph, NextStep, ProofArguments, Status, TextResult } from "./flow-contract.ts";
import type { BatonError } from "./token.ts";

export type Output = { source: RecordStep; id: string };

export type Route = { when: { toString(): string }; pass: RecordStep; fail: RecordStep };

export type RecordStep = {
  name: string;
  description: string;
  ttl: number;
  locked: boolean | undefined;
  dependencies: Set<RecordStep>;
  links: Map<string, Output>;
  outputs: Map<string, { toString(): string }>;
  schema: Record<string, unknown> | null;
  bound: boolean;
  route: Route | null;
};

export type RuntimeOptions = { locked?: boolean; ttl?: number; from?: Record<string, unknown> };

export type Invocation<Result> = {
  result: Result;

  values(): [string, unknown][];

  selected(): boolean | undefined;
};

export type Execution<Result, Failure extends object = never> =
  | Failure
  | { kind: "refusal"; error: BatonError }
  | { kind: "warning"; result: Result; warning: { code: BatonError["code"]; message: string } }
  | { kind: "success"; result: Result; proof_token: string; next: NextStep[] };

export interface Engine<Name extends string> {
  readonly name: Name;
  readonly prefix: string;

  step(name: string, options?: RuntimeOptions): RecordStep;

  depend(step: RecordStep, dependencies: unknown[]): void;

  describe(step: RecordStep): string;

  description(step: RecordStep, description: string): void;

  schema(step: RecordStep, shape: unknown, injected: Record<string, unknown>): void;

  bind(step: RecordStep, handler: unknown): void;

  handle(step: RecordStep, handle: object): void;

  output(step: RecordStep, reference: object, selector: { toString(): string }): string;

  route(
    step: RecordStep,
    branch: { when: { toString(): string }; pass: unknown; fail: unknown },
  ): void;

  execute<Args extends object, Result, Failure extends object = never>(
    step: RecordStep,
    args: Args & ProofArguments,
    invoke: (inputs: Args) => Promise<Invocation<Result>>,
    failure?: (result: Result) => Failure | null,
  ): Promise<Execution<Result, Failure>>;

  status(args: ProofArguments): Promise<Status>;

  list(args: ProofArguments): Promise<FlowGraph>;

  refresh(args: ProofArguments): Promise<Status & { proof_token: string }>;

  mcpMeta(
    action: () => Promise<Status | FlowGraph | (Status & { proof_token: string })>,
  ): Promise<TextResult>;
}
