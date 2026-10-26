import type { ErrorCode, Evidence, JsonValue } from "./token.ts";

export const flowType = Symbol("baton.flow");

export const resultType = Symbol("baton.result");

export const valueType = Symbol("baton.value");

export type ProofInput = string | readonly string[];

export type ProofArguments = { proof_token?: ProofInput | null | undefined };

export type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export type McpResult = {
  content: unknown[];
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
};

export interface NextStep {
  tool: string;
  inputs: Record<string, JsonValue>;
}

export interface Warning {
  code: ErrorCode;
  message: string;
}

export interface Reply<Result> {
  result: Result;
  proof_token: string | null;
  next: NextStep[];
  warning?: Warning;
}

export interface Status {
  flow: string;
  run: string;
  completed: string[];
  evidence: Record<string, Evidence>;
  next: NextStep[];
  expires_in: number;
}

export interface FlowGraph {
  flow: string;
  entries: string[];
  steps: {
    tool: string;
    description: string;
    locked: boolean;
    ttl: number;
    dependencies: string[];
    next: string[];
    branch: { pass: string; fail: string } | null;
    inputs: Record<string, { tool: string; output: string }>;
  }[];
}

export interface Config<Name extends string, Mcp extends boolean = false> {
  name: Name;
  secret: string;
  mcp?: Mcp;
  grace?: number;
  namespace?: string;
  now?: () => number;
}

export interface StepRef<Flow extends string, Result = unknown> {
  readonly name: string;
  readonly [flowType]: Flow;
  readonly [resultType]: readonly Result[];
}

export interface OutputRef<Flow extends string, Value> {
  readonly [flowType]: Flow;
  readonly [valueType]: readonly Value[];
}

export interface StepOptions<Flow extends string> {
  locked?: boolean;
  ttl?: number;
  from?: Record<string, OutputRef<Flow, unknown>>;
}

export type JsonCompatible<Value> = Value extends JsonValue
  ? Value
  : Value extends (...args: never[]) => unknown
    ? never
    : Value extends object
      ? { [Key in keyof Value]: JsonCompatible<Value[Key]> }
      : never;

export type JsonData<Value> = Value extends JsonValue
  ? Value
  : Value extends object
    ? { -readonly [Key in keyof Value]: JsonData<Value[Key]> }
    : never;

export type HasLinks<Rule> = Rule extends { from: infer Links }
  ? keyof Links extends never
    ? false
    : true
  : false;

export type CanBind<Rule, Dependency extends boolean> = "locked" extends keyof Rule
  ? true extends Rule["locked"]
    ? Dependency
    : true
  : true;

type LinksOf<Rule> = Rule extends { from: infer Links } ? Links : Record<never, never>;

type InvalidLinks<Args, Links> = {
  [Key in keyof Links]: Key extends keyof Args
    ? Links[Key] extends OutputRef<string, infer Value>
      ? [Value] extends [Args[Key]]
        ? never
        : Key
      : Key
    : Key;
}[keyof Links];

export type CheckInputs<Args, Rule> = "proof_token" extends keyof Args
  ? { readonly __baton_owns_proof_token: never }
  : [InvalidLinks<Args, LinksOf<Rule>>] extends [never]
    ? unknown
    : { readonly __invalid_input_links: InvalidLinks<Args, LinksOf<Rule>> };

export type OptionArguments<Rule, Flow extends string> =
  Exclude<keyof Rule, keyof StepOptions<Flow>> extends never ? [] : [invalid_options: never];

export type HandlerResult<Mcp extends boolean> = Mcp extends true
  ? McpResult | Promise<McpResult>
  : unknown;

export type McpReply<Result extends McpResult> =
  | (Omit<Result, "content"> & {
      content: (Result["content"][number] | { type: "text"; text: string })[];
      isError?: boolean | undefined;
    })
  | { content: TextResult["content"]; isError: true };

export type Returned<Result, Mcp extends boolean> = Mcp extends true
  ? McpReply<Result & McpResult>
  : Reply<Result>;

export type StepHandle<
  Flow extends string,
  Name extends string,
  Args extends object,
  Result,
  Extra extends unknown[],
  Response,
> = StepRef<Flow, Result> & {
  (args: Args & ProofArguments, ...extra: Extra): Promise<Response>;
  readonly name: Name;
  readonly description: string;
  readonly func: (args: Args & ProofArguments, ...extra: Extra) => Promise<Response>;

  output<Value>(
    select: (result: Result) => Value & JsonCompatible<Value>,
  ): OutputRef<Flow, JsonData<Value>>;

  branch(branch: {
    when: (result: Result) => boolean;
    pass: StepRef<Flow>;
    fail: StepRef<Flow>;
  }): void;
};

export type BoundStep<
  Flow extends string,
  Name extends string,
  Args extends object,
  Result,
  Extra extends unknown[],
  Mcp extends boolean,
> = StepHandle<Flow, Name, Args, Result, Extra, Returned<Result, Mcp>>;

export type BindRequirement<Rule, Dependency extends boolean> =
  CanBind<Rule, Dependency> extends true ? unknown : { readonly __baton_needs_prerequisite: never };

export interface UndescribedStep<
  Flow extends string,
  Name extends string,
  Rule,
  Mcp extends boolean,
  Dependency extends boolean,
> {
  readonly name: Name;
  readonly func: never;

  description(text: string): DescribedStep<Flow, Name, Rule, Mcp, Dependency>;

  dependsOn(
    first: StepRef<Flow>,
    ...others: StepRef<Flow>[]
  ): UndescribedStep<Flow, Name, Rule, Mcp, true>;
}

export interface DescribedStep<
  Flow extends string,
  Name extends string,
  Rule,
  Mcp extends boolean,
  Dependency extends boolean,
> {
  readonly name: Name;
  readonly description: string;

  func<Args extends object, Result extends HandlerResult<Mcp>, Extra extends unknown[]>(
    handler: ((args: Args, ...extra: Extra) => Result) &
      CheckInputs<NoInfer<Args>, Rule> &
      BindRequirement<Rule, Dependency>,
  ): BoundStep<Flow, Name, Args, Awaited<Result>, Extra, Mcp>;

  dependsOn(
    first: StepRef<Flow>,
    ...others: StepRef<Flow>[]
  ): DescribedStep<Flow, Name, Rule, Mcp, true>;
}

export type StepBuilder<
  Flow extends string,
  Name extends string,
  Rule,
  Mcp extends boolean,
  Dependency extends boolean = HasLinks<Rule>,
  Description extends string | undefined = undefined,
> = Description extends string
  ? DescribedStep<Flow, Name, Rule, Mcp, Dependency>
  : UndescribedStep<Flow, Name, Rule, Mcp, Dependency>;

export interface Flow<Name extends string, Mcp extends boolean = false> {
  readonly name: Name;

  step<const Tool extends string, const Rule extends StepOptions<Name> = Record<never, never>>(
    name: Tool,
    options?: Rule,
    ...check: OptionArguments<Rule, Name>
  ): StepBuilder<Name, Tool, Rule, Mcp>;

  status(args: { proof_token: ProofInput }): Promise<Mcp extends true ? TextResult : Status>;

  graph(): FlowGraph;

  list(args: { proof_token: ProofInput }): Promise<Mcp extends true ? TextResult : FlowGraph>;

  refresh(args: {
    proof_token: ProofInput;
  }): Promise<Mcp extends true ? TextResult : Status & { proof_token: string }>;
}
