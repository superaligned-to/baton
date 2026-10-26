import { registerWorkflow } from "./catalog.ts";
import type { Config, Flow } from "./flow-contract.ts";
import { createEngine } from "./gate.ts";
import { createMcpBinder, createPlainBinder, createSteps } from "./step-builder.ts";

export type {
  BoundStep,
  Config,
  Flow,
  FlowGraph,
  NextStep,
  OutputRef,
  ProofArguments,
  ProofInput,
  Reply,
  Status,
  StepBuilder,
  StepOptions,
  StepRef,
  TextResult,
  Warning,
} from "./flow-contract.ts";

export { BatonError, type ErrorCode, type Evidence, type JsonValue } from "./token.ts";

export function baton<const Name extends string>(
  config: Config<Name, true> & { mcp: true },
): Flow<Name, true>;

export function baton<const Name extends string>(config: Config<Name, false>): Flow<Name, false>;

export function baton<const Name extends string>(
  config: Config<Name, boolean>,
): Flow<Name, true> | Flow<Name, false> {
  const engine = createEngine(config);

  const flow: Flow<Name, true> | Flow<Name, false> = config.mcp
    ? {
        name: config.name,
        step: createSteps(engine, createMcpBinder(engine)),
        status: (args) => engine.mcpMeta(() => engine.status(args)),
        graph: engine.graph,
        list: (args) => engine.mcpMeta(() => engine.list(args)),
        refresh: (args) => engine.mcpMeta(() => engine.refresh(args)),
      }
    : {
        name: config.name,
        step: createSteps(engine, createPlainBinder(engine)),
        status: engine.status,
        graph: engine.graph,
        list: engine.list,
        refresh: engine.refresh,
      };

  registerWorkflow(flow);

  return flow;
}
