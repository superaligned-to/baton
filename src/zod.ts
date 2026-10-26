import { z } from "zod";
import {
  type Catalog,
  type CatalogArguments,
  type CatalogOptions,
  catalog as createCatalog,
  type WorkflowSource,
} from "./catalog.ts";
import type {
  BindRequirement,
  BoundStep,
  CheckInputs,
  Config,
  Flow,
  HandlerResult,
  HasLinks,
  OptionArguments,
  ProofArguments,
  StepOptions,
  StepRef,
  TextResult,
} from "./flow-contract.ts";
import { createEngine } from "./gate.ts";
import { type Binder, createMcpBinder, createPlainBinder, type StepState } from "./step-builder.ts";
import type { Engine } from "./step-record.ts";

type TokenField = z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;

type Injected<Shape extends z.ZodRawShape> = Shape & { proof_token: TokenField };

type Arguments<Shape extends z.ZodRawShape> = keyof Shape extends never
  ? Record<never, never>
  : z.output<z.ZodObject<Shape>>;

type WireArguments<Shape extends z.ZodRawShape> = keyof Shape extends never
  ? Record<never, never>
  : z.input<z.ZodObject<Shape>>;

type ShapeCheck<Shape extends z.ZodRawShape, Rule> = CheckInputs<Arguments<NoInfer<Shape>>, Rule> &
  CheckInputs<WireArguments<NoInfer<Shape>>, Rule>;

class Stage<Name extends string, Tool extends string, Mcp extends boolean> {
  constructor(
    protected readonly engine: Engine<Name>,
    protected readonly state: StepState<Tool>,
    protected readonly binder: Binder<Name, Mcp>,
    protected readonly proof: TokenField,
  ) {}

  get name(): Tool {
    return this.state.name;
  }

  protected attach<Shape extends z.ZodRawShape>(shape: Shape): Injected<Shape> {
    const injected = { ...shape, proof_token: this.proof };

    this.engine.schema(this.state.record, shape, injected);

    return injected;
  }
}

class BareStep<
  Name extends string,
  Tool extends string,
  Rule,
  Mcp extends boolean,
  Dependency extends boolean,
> extends Stage<Name, Tool, Mcp> {
  get func(): never {
    throw new TypeError("baton: attach a description before binding the handler");
  }

  readonly description = (text: string): DescribedStep<Name, Tool, Rule, Mcp, Dependency> => {
    this.engine.description(this.state.record, text);

    return new DescribedStep(this.engine, this.state, this.binder, this.proof);
  };

  readonly schema = <const Shape extends z.ZodRawShape>(
    shape: Shape & ShapeCheck<Shape, Rule>,
  ): ShapedStep<Name, Tool, Rule, Mcp, Dependency, Shape> => {
    const injected = this.attach<Shape>(shape);

    return new ShapedStep(this.engine, this.state, this.binder, this.proof, injected);
  };

  readonly dependsOn = (
    ...dependencies: [StepRef<Name>, ...StepRef<Name>[]]
  ): BareStep<Name, Tool, Rule, Mcp, true> => {
    this.engine.depend(this.state.record, dependencies);

    return new BareStep(this.engine, this.state, this.binder, this.proof);
  };
}

class DescribedStep<
  Name extends string,
  Tool extends string,
  Rule,
  Mcp extends boolean,
  Dependency extends boolean,
> extends Stage<Name, Tool, Mcp> {
  get description(): string {
    return this.engine.describe(this.state.record);
  }

  get func(): never {
    throw new TypeError("baton: attach a schema before binding the handler");
  }

  readonly schema = <const Shape extends z.ZodRawShape>(
    shape: Shape & ShapeCheck<Shape, Rule>,
  ): ReadyStep<Name, Tool, Rule, Mcp, Dependency, Shape> => {
    const injected = this.attach<Shape>(shape);

    return new ReadyStep(this.engine, this.state, this.binder, this.proof, injected);
  };

  readonly dependsOn = (
    ...dependencies: [StepRef<Name>, ...StepRef<Name>[]]
  ): DescribedStep<Name, Tool, Rule, Mcp, true> => {
    this.engine.depend(this.state.record, dependencies);

    return new DescribedStep(this.engine, this.state, this.binder, this.proof);
  };
}

class ShapedStep<
  Name extends string,
  Tool extends string,
  Rule,
  Mcp extends boolean,
  Dependency extends boolean,
  Shape extends z.ZodRawShape,
> extends Stage<Name, Tool, Mcp> {
  constructor(
    engine: Engine<Name>,
    state: StepState<Tool>,
    binder: Binder<Name, Mcp>,
    proof: TokenField,
    readonly schema: Injected<Shape>,
  ) {
    super(engine, state, binder, proof);
  }

  get func(): never {
    throw new TypeError("baton: attach a description before binding the handler");
  }

  readonly description = (text: string): ReadyStep<Name, Tool, Rule, Mcp, Dependency, Shape> => {
    this.engine.description(this.state.record, text);

    return new ReadyStep(this.engine, this.state, this.binder, this.proof, this.schema);
  };

  readonly dependsOn = (
    ...dependencies: [StepRef<Name>, ...StepRef<Name>[]]
  ): ShapedStep<Name, Tool, Rule, Mcp, true, Shape> => {
    this.engine.depend(this.state.record, dependencies);

    return new ShapedStep(this.engine, this.state, this.binder, this.proof, this.schema);
  };
}

class ReadyStep<
  Name extends string,
  Tool extends string,
  Rule,
  Mcp extends boolean,
  Dependency extends boolean,
  Shape extends z.ZodRawShape,
> extends Stage<Name, Tool, Mcp> {
  constructor(
    engine: Engine<Name>,
    state: StepState<Tool>,
    binder: Binder<Name, Mcp>,
    proof: TokenField,
    readonly schema: Injected<Shape>,
  ) {
    super(engine, state, binder, proof);
  }

  get description(): string {
    return this.engine.describe(this.state.record);
  }

  readonly func = <Result extends HandlerResult<Mcp>, Extra extends unknown[]>(
    handler: ((args: Arguments<Shape>, ...extra: Extra) => Result) &
      BindRequirement<Rule, Dependency>,
  ): BoundStep<Name, Tool, Arguments<Shape>, Awaited<Result>, Extra, Mcp> & {
    readonly schema: Injected<Shape>;
  } => {
    const handle = this.binder.bind(this.state, handler);
    const shaped = Object.assign(handle, { schema: this.schema });

    Object.defineProperty(shaped, "schema", {
      writable: false,
      enumerable: false,
      configurable: false,
    });

    return shaped;
  };

  readonly dependsOn = (
    ...dependencies: [StepRef<Name>, ...StepRef<Name>[]]
  ): ReadyStep<Name, Tool, Rule, Mcp, true, Shape> => {
    this.engine.depend(this.state.record, dependencies);

    return new ReadyStep(this.engine, this.state, this.binder, this.proof, this.schema);
  };
}

export interface MetaTool {
  readonly name: string;
  readonly description: string;
  readonly schema: { proof_token: TokenField };
  readonly func: (args: ProofArguments, extra?: unknown) => Promise<TextResult>;
}

type ZodSteps<Name extends string, Mcp extends boolean> = <
  const Tool extends string,
  const Rule extends StepOptions<Name> = Record<never, never>,
>(
  name: Tool,
  options?: Rule,
  ...check: OptionArguments<Rule, Name>
) => BareStep<Name, Tool, Rule, Mcp, HasLinks<Rule>>;

export type ZodFlow<Name extends string, Mcp extends boolean = false> = Omit<
  Flow<Name, Mcp>,
  "step"
> & {
  readonly step: ZodSteps<Name, Mcp>;

  metaTools(): readonly MetaTool[];
};

const createSteps =
  <Name extends string, Mcp extends boolean>(
    engine: Engine<Name>,
    binder: Binder<Name, Mcp>,
    proof: TokenField,
  ): ZodSteps<Name, Mcp> =>
  <const Tool extends string, const Rule extends StepOptions<Name> = Record<never, never>>(
    name: Tool,
    options?: Rule,
    ..._check: OptionArguments<Rule, Name>
  ): BareStep<Name, Tool, Rule, Mcp, HasLinks<Rule>> =>
    new BareStep(
      engine,
      {
        name,
        record: engine.step(name, options),
      },
      binder,
      proof,
    );

const metaTools = <Name extends string>(
  engine: Engine<Name>,
  proof: TokenField,
): readonly MetaTool[] =>
  (["status", "list", "refresh"] as const).map((kind) => ({
    name: engine.prefix + kind,
    description:
      kind === "status"
        ? `Inspect verified proof, linked values, and next calls in ${engine.name}.`
        : kind === "list"
          ? "Read the workflow graph using a valid proof_token."
          : "Renew a signed token without renewing expired dependency evidence.",
    schema: { proof_token: proof },
    func: (args: ProofArguments) => engine.mcpMeta(() => engine[kind](args)),
  }));

export function baton<const Name extends string>(
  config: Config<Name, true> & { mcp: true },
): ZodFlow<Name, true>;

export function baton<const Name extends string>(config: Config<Name, false>): ZodFlow<Name, false>;

export function baton<const Name extends string>(
  config: Config<Name, boolean>,
): ZodFlow<Name, true> | ZodFlow<Name, false> {
  const engine = createEngine(config);

  const proof = z
    .union([z.string(), z.array(z.string()).min(1)])
    .optional()
    .describe(`The proof_token returned by a tool in ${config.name}.`);

  if (config.mcp) {
    return {
      name: config.name,
      step: createSteps(engine, createMcpBinder(engine), proof),
      status: (args) => engine.mcpMeta(() => engine.status(args)),
      graph: engine.graph,
      list: (args) => engine.mcpMeta(() => engine.list(args)),
      refresh: (args) => engine.mcpMeta(() => engine.refresh(args)),
      metaTools: () => metaTools(engine, proof),
    };
  }

  return {
    name: config.name,
    step: createSteps(engine, createPlainBinder(engine), proof),
    status: engine.status,
    graph: engine.graph,
    list: engine.list,
    refresh: engine.refresh,
    metaTools: () => metaTools(engine, proof),
  };
}

export type ZodCatalogTool = {
  readonly name: string;
  readonly description: string;
  readonly schema: {
    readonly workflow: z.ZodOptional<z.ZodString>;
    readonly format: z.ZodOptional<z.ZodEnum<{ json: "json"; mermaid: "mermaid" }>>;
  };
  readonly func: (args: CatalogArguments) => Promise<TextResult>;
};

export type ZodCatalog = Omit<Catalog, "tool"> & { tool(): ZodCatalogTool };

export const catalog = (
  workflows: readonly WorkflowSource[],
  options: CatalogOptions = {},
): ZodCatalog => {
  const base = createCatalog(workflows, options);
  const tool = base.tool();

  return {
    name: base.name,
    list: base.list,
    graph: base.graph,
    describe: base.describe,
    tool: () => ({
      name: tool.name,
      description: tool.description,
      schema: {
        workflow: z.string().optional().describe("Workflow name; omit to list every workflow."),
        format: z.enum(["json", "mermaid"]).optional().describe("Graph format; defaults to json."),
      },
      func: tool.func,
    }),
  };
};

export type {
  CatalogArguments,
  CatalogOptions,
  WorkflowFormat,
  WorkflowList,
  WorkflowSource,
  WorkflowSummary,
} from "./catalog.ts";

export type { Config, FlowGraph, NextStep, Reply, Status } from "./flow-contract.ts";

export { BatonError } from "./token.ts";
