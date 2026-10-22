import {
  type BindRequirement,
  type BoundStep,
  type CheckInputs,
  type DescribedStep,
  flowType,
  type HandlerResult,
  type HasLinks,
  type JsonCompatible,
  type JsonData,
  type McpReply,
  type McpResult,
  type OptionArguments,
  type OutputRef,
  type ProofArguments,
  type Reply,
  resultType,
  type StepHandle,
  type StepOptions,
  type StepRef,
  type UndescribedStep,
  valueType,
} from "./flow-contract.ts";
import type { Engine, Execution, Invocation, RecordStep } from "./step-record.ts";

export interface StepState<Tool extends string> {
  readonly name: Tool;
  readonly record: RecordStep;
}

export interface Binder<Name extends string, Mcp extends boolean> {
  bind<
    Tool extends string,
    Args extends object,
    Result extends HandlerResult<Mcp>,
    Extra extends unknown[],
  >(
    state: StepState<Tool>,
    handler: (args: Args, ...extra: Extra) => Result,
  ): BoundStep<Name, Tool, Args, Awaited<Result>, Extra, Mcp>;
}

const createHandle = <
  Name extends string,
  Tool extends string,
  Args extends object,
  Result,
  Extra extends unknown[],
  Response,
>(
  engine: Engine<Name>,
  state: StepState<Tool>,
  run: (
    args: Args & ProofArguments,
    extra: Extra,
    evaluate: (result: Result) => Invocation<Result>,
  ) => Promise<Response>,
): StepHandle<Name, Tool, Args, Result, Extra, Response> => {
  const selectors = new Map<string, (result: Result) => unknown>();
  let predicate: ((result: Result) => boolean) | null = null;

  const wrapped = (args: Args & ProofArguments, ...extra: Extra): Promise<Response> =>
    run(args, extra, (result) => ({
      result,
      values: () => [...selectors].map(([id, select]): [string, unknown] => [id, select(result)]),
      selected: () => (predicate === null ? undefined : predicate(result)),
    }));

  Object.defineProperty(wrapped, "name", { writable: true });

  const handle = Object.assign(wrapped, {
    name: state.name,
    description: "",
    schema: state.record.schema,
    func: wrapped,
    [flowType]: engine.name,
    [resultType]: Object.freeze([]),

    output<Value>(
      select: (result: Result) => Value & JsonCompatible<Value>,
    ): OutputRef<Name, JsonData<Value>> {
      const reference = Object.freeze({
        [flowType]: engine.name,
        [valueType]: Object.freeze([]),
      });

      const id = engine.output(state.record, reference, select);

      selectors.set(id, select);

      return reference;
    },

    branch(branch: {
      when: (result: Result) => boolean;
      pass: StepRef<Name>;
      fail: StepRef<Name>;
    }): void {
      const { when, pass, fail } = branch;

      engine.route(state.record, { when, pass, fail });
      predicate = when;
    },
  });

  Object.defineProperties(handle, {
    name: { writable: false },
    description: {
      get: () => engine.describe(state.record),
      enumerable: false,
      configurable: false,
    },
    func: { writable: false, enumerable: false, configurable: false },
    output: { writable: false, enumerable: false, configurable: false },
    branch: { writable: false, enumerable: false, configurable: false },
  });
  engine.handle(state.record, handle);

  return handle;
};

const plainReply = <Result>(execution: Execution<Result>): Reply<Result> => {
  if (execution.kind === "refusal") {
    throw execution.error;
  }

  if (execution.kind === "warning") {
    return { result: execution.result, proof_token: null, next: [], warning: execution.warning };
  }

  return { result: execution.result, proof_token: execution.proof_token, next: execution.next };
};

const append = <Result extends McpResult>(result: Result, message: string): McpReply<Result> => {
  if (typeof result !== "object" || result === null || !Array.isArray(result.content)) {
    throw new TypeError("baton: MCP handlers must return a result with a content array");
  }

  const { content, ...rest } = result;

  return {
    ...rest,
    content: [...content, { type: "text", text: message }],
  };
};

const mcpReply = <Result extends McpResult>(
  execution: Execution<Result, { kind: "failed"; result: Result }>,
): McpReply<Result> => {
  if (execution.kind === "refusal") {
    return {
      content: [{ type: "text", text: `${execution.error.code}: ${execution.error.message}` }],
      isError: true,
    };
  }

  if (execution.kind === "failed") {
    return execution.result;
  }

  if (execution.kind === "warning") {
    return append(
      execution.result,
      `Warning: ${execution.warning.code}: ${execution.warning.message}`,
    );
  }

  const next =
    execution.next.length === 0
      ? "This flow is finished."
      : `Next: ${execution.next.map((step) => `${step.tool} ${JSON.stringify(step.inputs)}`).join(" or ")}. Pass the proof_token.`;

  return append(execution.result, `proof_token: ${execution.proof_token}\n${next}`);
};

export const createPlainBinder = <Name extends string>(
  engine: Engine<Name>,
): Binder<Name, false> => ({
  bind: (state, handler) => {
    engine.bind(state.record, handler);

    return createHandle(engine, state, async (args, extra, evaluate) => {
      const execution = await engine.execute(state.record, args, async (inputs) => {
        return evaluate(await handler(inputs, ...extra));
      });

      return plainReply(execution);
    });
  },
});

export const createMcpBinder = <Name extends string>(engine: Engine<Name>): Binder<Name, true> => ({
  bind: (state, handler) => {
    engine.bind(state.record, handler);

    return createHandle(engine, state, async (args, extra, evaluate) => {
      const execution = await engine.execute(
        state.record,
        args,
        async (inputs) => {
          return evaluate(await handler(inputs, ...extra));
        },
        (result): { kind: "failed"; result: typeof result } | null => {
          if (
            typeof result === "object" &&
            result !== null &&
            !Array.isArray(result) &&
            result.isError === true
          ) {
            return { kind: "failed", result };
          }

          return null;
        },
      );

      return mcpReply<Awaited<ReturnType<typeof handler>> & McpResult>(execution);
    });
  },
});

class InitialStep<
  Name extends string,
  Tool extends string,
  Rule,
  Mcp extends boolean,
  Dependency extends boolean,
> implements UndescribedStep<Name, Tool, Rule, Mcp, Dependency>
{
  constructor(
    private readonly engine: Engine<Name>,
    private readonly state: StepState<Tool>,
    private readonly binder: Binder<Name, Mcp>,
  ) {}

  get name(): Tool {
    return this.state.name;
  }

  get func(): never {
    throw new TypeError("baton: attach a description before binding the handler");
  }

  readonly description = (text: string): DescribedStep<Name, Tool, Rule, Mcp, Dependency> => {
    this.engine.description(this.state.record, text);

    return new ReadyStep(this.engine, this.state, this.binder);
  };

  readonly dependsOn = (
    ...dependencies: [StepRef<Name>, ...StepRef<Name>[]]
  ): UndescribedStep<Name, Tool, Rule, Mcp, true> => {
    this.engine.depend(this.state.record, dependencies);

    return new InitialStep(this.engine, this.state, this.binder);
  };
}

class ReadyStep<
  Name extends string,
  Tool extends string,
  Rule,
  Mcp extends boolean,
  Dependency extends boolean,
> implements DescribedStep<Name, Tool, Rule, Mcp, Dependency>
{
  constructor(
    private readonly engine: Engine<Name>,
    private readonly state: StepState<Tool>,
    private readonly binder: Binder<Name, Mcp>,
  ) {}

  get name(): Tool {
    return this.state.name;
  }

  get description(): string {
    return this.engine.describe(this.state.record);
  }

  readonly func = <Args extends object, Result extends HandlerResult<Mcp>, Extra extends unknown[]>(
    handler: ((args: Args, ...extra: Extra) => Result) &
      CheckInputs<NoInfer<Args>, Rule> &
      BindRequirement<Rule, Dependency>,
  ): BoundStep<Name, Tool, Args, Awaited<Result>, Extra, Mcp> => {
    const handle = this.binder.bind(this.state, handler);

    Object.defineProperty(handle, "schema", {
      writable: false,
      enumerable: false,
      configurable: false,
    });

    return handle;
  };

  readonly dependsOn = (
    ...dependencies: [StepRef<Name>, ...StepRef<Name>[]]
  ): DescribedStep<Name, Tool, Rule, Mcp, true> => {
    this.engine.depend(this.state.record, dependencies);

    return new ReadyStep(this.engine, this.state, this.binder);
  };
}

export const createSteps =
  <Name extends string, Mcp extends boolean>(
    engine: Engine<Name>,
    binder: Binder<Name, Mcp>,
  ): (<const Tool extends string, const Rule extends StepOptions<Name> = Record<never, never>>(
    name: Tool,
    options?: Rule,
    ..._check: OptionArguments<Rule, Name>
  ) => UndescribedStep<Name, Tool, Rule, Mcp, HasLinks<Rule>>) =>
  <const Tool extends string, const Rule extends StepOptions<Name> = Record<never, never>>(
    name: Tool,
    options?: Rule,
    ..._check: OptionArguments<Rule, Name>
  ): UndescribedStep<Name, Tool, Rule, Mcp, HasLinks<Rule>> =>
    new InitialStep<Name, Tool, Rule, Mcp, HasLinks<Rule>>(
      engine,
      {
        name,
        record: engine.step(name, options),
      },
      binder,
    );
