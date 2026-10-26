import type { FlowGraph, TextResult } from "./flow-contract.ts";

export type WorkflowFormat = "json" | "mermaid";

export interface WorkflowSource {
  readonly name: string;
  graph(): FlowGraph;
}

export interface WorkflowSummary {
  name: string;
  entries: string[];
  step_count: number;
}

export interface WorkflowList {
  workflows: WorkflowSummary[];
}

export interface CatalogArguments {
  workflow?: string | undefined;
  format?: WorkflowFormat | undefined;
}

export interface CatalogTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: {
      readonly workflow: { readonly type: "string"; readonly description: string };
      readonly format: {
        readonly type: "string";
        readonly enum: readonly ["json", "mermaid"];
        readonly description: string;
      };
    };
    readonly additionalProperties: false;
  };
  readonly func: (args: CatalogArguments) => Promise<TextResult>;
}

export interface Catalog {
  readonly name: string;
  list(): WorkflowList;
  graph(workflow: string): FlowGraph;
  describe(args?: CatalogArguments): WorkflowList | FlowGraph | string;
  tool(): CatalogTool;
}

export interface CatalogOptions {
  name?: string;
}

const fail = (message: string): never => {
  throw new TypeError(`baton: ${message}`);
};

const nodeShape = (graph: FlowGraph, step: FlowGraph["steps"][number]): string => {
  if (step.branch !== null) {
    return `{"${step.tool}"}`;
  }

  return graph.entries.includes(step.tool) ? `(["${step.tool}"])` : `["${step.tool}"]`;
};

const renderOne = (graph: FlowGraph, group?: string): string[] => {
  const id = (tool: string): string => (group === undefined ? `n_${tool}` : `${group}_${tool}`);
  const lines = [group === undefined ? "flowchart LR" : `  subgraph ${group}["${graph.flow}"]`];
  const indent = group === undefined ? "  " : "    ";

  for (const step of graph.steps) {
    lines.push(`${indent}${id(step.tool)}${nodeShape(graph, step)}`);
  }

  if (graph.steps.some((step) => step.branch !== null || step.next.length > 0)) {
    lines.push("");
  }

  for (const step of graph.steps) {
    if (step.branch === null) {
      for (const target of step.next) {
        lines.push(`${indent}${id(step.tool)} --> ${id(target)}`);
      }
    } else {
      lines.push(`${indent}${id(step.tool)} -- pass --> ${id(step.branch.pass)}`);
      lines.push(`${indent}${id(step.tool)} -- fail --> ${id(step.branch.fail)}`);
    }
  }

  if (group !== undefined) {
    lines.push("  end");
  }

  return lines;
};

export const catalog = (
  workflows: readonly WorkflowSource[],
  options: CatalogOptions = {},
): Catalog => {
  const name = options.name ?? "baton_workflows";

  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    fail("catalog names must contain only letters, numbers, underscores, or hyphens");
  }

  if (workflows.length === 0) {
    fail("catalog needs at least one workflow");
  }

  const sources = new Map<string, WorkflowSource>();

  for (const workflow of workflows) {
    if (sources.has(workflow.name)) {
      fail(`workflow ${workflow.name} is already in this catalog`);
    }

    sources.set(workflow.name, workflow);
  }

  const graph = (workflow: string): FlowGraph => {
    const source = sources.get(workflow);

    if (source === undefined) {
      return fail(
        `unknown workflow ${workflow}; available workflows are ${[...sources.keys()].join(", ")}`,
      );
    }

    return source.graph();
  };

  const summaries = (): WorkflowSummary[] =>
    [...sources.values()].map((source) => {
      const data = source.graph();

      return { name: source.name, entries: data.entries, step_count: data.steps.length };
    });

  const list = (): WorkflowList => ({ workflows: summaries() });

  const describe = (args: CatalogArguments = {}): WorkflowList | FlowGraph | string => {
    const format = args.format ?? "json";

    if (format !== "json" && format !== "mermaid") {
      fail("format must be json or mermaid");
    }

    if (args.workflow !== undefined) {
      const data = graph(args.workflow);

      return format === "mermaid" ? renderOne(data).join("\n") : data;
    }

    if (format === "json") {
      return list();
    }

    const graphs = [...sources.values()].map((source) => source.graph());
    const lines = ["flowchart LR"];

    for (const [index, data] of graphs.entries()) {
      lines.push(...renderOne(data, `workflow_${index}`));
    }

    return lines.join("\n");
  };

  const func = async (args: CatalogArguments = {}): Promise<TextResult> => {
    try {
      const data = describe(args);

      if (typeof data === "string") {
        return { content: [{ type: "text", text: data }] };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: { ...data },
      };
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }

      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  };

  const tool = (): CatalogTool => ({
    name,
    description:
      "List available workflows, or read one workflow graph as JSON or Mermaid. Requires no proof_token.",
    inputSchema: {
      type: "object",
      properties: {
        workflow: {
          type: "string",
          description: "Workflow name; omit to list every workflow.",
        },
        format: {
          type: "string",
          enum: ["json", "mermaid"],
          description: "Graph format; defaults to json.",
        },
      },
      additionalProperties: false,
    },
    func,
  });

  return { name, list, graph, describe, tool };
};
