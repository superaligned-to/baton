import type {
  Challenge,
  ChallengeConfig,
  FlowRef,
  Locked,
  TextResult,
  Tool,
} from "./flow-contract.ts";
import type { Engine, RecordStep } from "./step-record.ts";
import { BatonError, type Evidence } from "./token.ts";

type Check = (args: object, extra: readonly unknown[]) => boolean | Promise<boolean>;

interface Target {
  readonly engine: Engine<string> | undefined;
  lets(tool: string): boolean;
  instruction(): string;
  done(evidence: Record<string, Evidence>, now: number): boolean;
}

interface State {
  readonly config: ChallengeConfig<boolean>;
  readonly target?: Target;
  readonly check?: Check;
}

export interface Lock {
  readonly engine: Engine<string> | undefined;
  lets(tool: string): boolean;
  solved(args: object, extra: readonly unknown[]): Promise<boolean>;
  refusal(): BatonError;
}

const MAX_TOKEN_LENGTH = 65_536;

const MAX_CANDIDATES = 16;

const engines = new WeakMap<object, Engine<string>>();
const registry = new WeakMap<object, () => Lock>();

const fail: (message: string) => never = (message) => {
  throw new TypeError(`baton: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tokensOf = (input: unknown): unknown[] =>
  Array.isArray(input)
    ? input
    : input === undefined || input === null || input === ""
      ? []
      : [input];

const flowOf = (token: unknown): string | undefined => {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !token.startsWith("bt1.")) {
    return undefined;
  }

  const end = token.indexOf(".", 4);

  return end === -1 ? undefined : token.slice(4, end);
};

const fresh = (evidence: Record<string, Evidence>, step: string, now: number): boolean =>
  (evidence[step]?.expiresAt ?? -1) >= now;

export const register = (key: object, engine: Engine<string>): void => {
  engines.set(key, engine);
};

const callTarget = (tool: Tool): Target => ({
  engine: engines.get(tool),
  lets: (name) => name === tool.name,
  instruction: () => `call ${tool.name}`,
  done: (evidence, now) => fresh(evidence, tool.name, now),
});

const flowTarget = (name: string, flow: FlowRef, end: Tool): Target => {
  const engine = engines.get(flow);

  if (engine === undefined || engines.get(end) !== engine) {
    fail(`challenge ${name} must finish with a step of flow ${flow.name}`);
  }

  return {
    engine,
    lets: (tool) => flow.graph().steps.some((step) => step.tool === tool),
    instruction: () =>
      `complete flow ${flow.name}: start with ${flow.graph().entries.join(" or ")} and finish with ${end.name}`,
    done: (evidence, now) => fresh(evidence, end.name, now),
  };
};

const proof = (name: string, target: Target | undefined): Check => {
  const engine = target?.engine;

  if (target === undefined || engine === undefined) {
    return fail(
      `challenge ${name} needs .check() unless it calls a baton step or follows a baton flow`,
    );
  }

  return async (args) => {
    const tokens = tokensOf(Reflect.get(args, "proof_token"))
      .filter((token): token is string => flowOf(token) === engine.name)
      .slice(0, MAX_CANDIDATES);

    for (const token of tokens) {
      try {
        const status = await engine.status({ proof_token: token });

        if (target.done(status.evidence, engine.now())) {
          return true;
        }
      } catch (error) {
        if (!(error instanceof BatonError)) {
          throw error;
        }
      }
    }

    return false;
  };
};

const toLock = ({ config, target, check }: State): Lock => {
  const described = config.description;

  const instruction =
    described !== undefined
      ? () => described
      : target !== undefined
        ? target.instruction
        : fail(`challenge ${config.name} needs a description, .call(), or .follow()`);

  const solved = check ?? proof(config.name, target);

  return {
    engine: target?.engine,
    lets: target === undefined ? () => false : target.lets,
    solved: async (args, extra) => solved(args, extra),
    refusal: () =>
      new BatonError(
        "challenge_required",
        `This tool is locked by challenge: ${config.name}. Solve it to unlock: ${instruction()}.`,
      ),
  };
};

const build = <Extra extends unknown[], Mcp extends boolean>(
  state: State,
): Challenge<Extra, Mcp> => {
  let cached: Lock | undefined;

  const lock = (): Lock => {
    cached ??= toLock(state);

    return cached;
  };

  const retarget = (target: () => Target): Challenge<Extra, Mcp> => {
    if (state.target !== undefined) {
      fail(`challenge ${state.config.name} takes one .call() or .follow()`);
    }

    return build({ ...state, target: target() });
  };

  const challenge: Challenge<Extra, Mcp> = {
    name: state.config.name,
    call: (tool) => retarget(() => callTarget(tool)),
    follow: (flow, end) => retarget(() => flowTarget(state.config.name, flow, end)),
    check: <Next extends unknown[]>(
      fn: (args: object, ...extra: Next) => boolean | Promise<boolean>,
    ): Challenge<Next, Mcp> => {
      if (state.check !== undefined) {
        fail(`challenge ${state.config.name} takes one .check()`);
      }

      return build({ ...state, check: (args, extra) => fn(args, ...(extra as Next)) });
    },
    lets: (tool) => lock().lets(tool),
    func: <Args extends object, Result, Given extends Extra>(
      handler: (args: Args, ...extra: Given) => Result,
    ) => {
      const { solved, refusal } = lock();

      return async (args: Args, ...extra: Given): Promise<Locked<Awaited<Result>, Mcp>> => {
        if (await solved(args, extra)) {
          return (await handler(args, ...extra)) as Locked<Awaited<Result>, Mcp>;
        }

        const error = refusal();

        if (state.config.mcp !== true) {
          throw error;
        }

        const reply: TextResult = {
          content: [{ type: "text", text: `${error.code}: ${error.message}` }],
          isError: true,
        };

        return reply as Locked<Awaited<Result>, Mcp>;
      };
    },
  };

  registry.set(challenge, lock);

  return challenge;
};

export const challenge = <const Mcp extends boolean = false>(
  config: ChallengeConfig<Mcp>,
): Challenge<unknown[], Mcp> => {
  if (typeof config.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(config.name)) {
    fail("challenge names must contain only letters, numbers, underscores, or hyphens");
  }

  if (config.description !== undefined && config.description.trim() === "") {
    fail("a challenge description must be a nonempty string");
  }

  return build({ config: { ...config } });
};

export const attach = (
  step: { record: RecordStep; locks: Lock[] },
  engine: Engine<string>,
  challenge: object,
): void => {
  if (step.record.bound) {
    fail("finished steps cannot change challenges");
  }

  const lock = registry.get(challenge);

  if (lock === undefined) {
    fail("withChallenge needs a challenge from challenge()");
  }

  if (lock().engine === engine) {
    fail(`${step.record.name} cannot be challenged by its own flow; use dependsOn`);
  }

  step.locks.push(lock());
};

export const admit = async <Args>(
  flow: string,
  locks: readonly Lock[],
  args: Args,
  extra: readonly unknown[],
): Promise<Args | BatonError> => {
  if (locks.length === 0 || !isRecord(args)) {
    return args;
  }

  for (const lock of locks) {
    if (!(await lock.solved(args, extra))) {
      return lock.refusal();
    }
  }

  const own = tokensOf(args.proof_token).filter((token) => {
    const owner = flowOf(token);

    return owner === undefined || owner === flow;
  });

  return { ...args, proof_token: own.length > 1 ? own : own[0] };
};
