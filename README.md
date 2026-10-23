# baton

<p align="center">
  <img src="https://raw.githubusercontent.com/superaligned-to/baton/main/.github/media/logo.png" alt="baton" width="96" height="144">
</p>

**Enforce tool dependencies without building another agent framework.**

Agents can skip steps. Your tools don’t have to let them.

- Require a read before an edit.
- Require tests and review before a release.
- Bind publishing to the exact artifact that passed its checks.

<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/superaligned-to/baton/main/.github/media/workflow.png">
    <img src="https://raw.githubusercontent.com/superaligned-to/baton/main/.github/media/workflow.gif" alt="Agents share an MCP server that requires build, test, and review before publishing." width="1040">
  </picture>
</p>

> [!NOTE]
> **For agents:** [MCP integration](#mcp) · [Calling gated tools](#calling-gated-tools) · [Repo instructions](AGENTS.md) · [Docs index](llms.txt).
> Keep the existing server and handlers. Pass `proof_token` unchanged and follow the reply’s `Next:` guidance.

## Install

Requires **Node 24+**. [Available on npm](https://www.npmjs.com/package/@superaligned/baton).

| Package manager | Command |
| --- | --- |
| npm | `npm install @superaligned/baton` |
| pnpm | `pnpm add @superaligned/baton` |
| Bun | `bun add @superaligned/baton` |
| Yarn | `yarn add @superaligned/baton` |

Set a signing secret:

```sh
export BATON_SECRET="$(openssl rand -base64 32)"
```

Use the same secret in every process serving a flow. Changing it invalidates existing tokens.

## API

Create a flow with `baton({ name, secret })` from `@superaligned/baton`. Wrap handlers with `flow.step(name, options).description(text).func(handler)`.

### Flow options

| Option | Default | Use |
| --- | --- | --- |
| `name` | Required | Flow identity carried in tokens |
| `secret` | Required | HMAC key of at least 32 bytes |
| `mcp` | `false` | Return MCP results and text refusals |
| `namespace` | None | Separate meta-tool names on one server |
| `grace` | `86400` seconds | Refresh window after token expiry |

Define all steps and branches before calling tools; later changes are refused. Steps without prerequisites start a new run; explicitly locked steps need a prerequisite.

### Step options

| Option | Default | Use |
| --- | --- | --- |
| `from` | None | Bind inputs to selected prerequisite outputs |
| `ttl` | `900` seconds | Evidence lifetime |
| `locked` | `true` with prerequisites | Refuse calls without valid evidence |

- `.dependsOn(first, ...others)` requires every named step.
- `from` declares prerequisites and binds inputs to `step.output(selector)`. Select from the handler result, or its `structuredContent` for MCP. Only selected values become signed evidence.
- `.branch({ when, pass, fail })` permits one next call based on the result. Return ordinary data such as `passed: false` to permit a retry.
- Rerunning an earlier step clears downstream evidence in the new token.
- Independent checks share a starting token. Pass their returned tokens together; they must belong to the same run with compatible histories.

Linked values must have compatible types, match at runtime, and contain JSON data.

Plain replies contain `result`, `proof_token`, and `next`. Refusals throw `BatonError` with a `code`. `locked: false` allows calls with invalid prerequisites, returning a `warning` and no usable proof.

## MCP

1. Import `baton` from `@superaligned/baton/zod` for Zod 4 schemas and set `mcp: true`.
2. Pass application fields to `.schema(shape)`; baton adds `proof_token`.
3. Register each handle’s `name`, `description`, `schema`, and `func` with your existing server. Register `flow.metaTools()` the same way.

Keep your transport and ungated tools. The core supports MCP with your host’s schemas too.

Handlers return normal MCP results. An `isError: true` result produces no completion evidence. Refusals return `isError: true` with `code: message` text.

## Calling gated tools

1. Call an entry tool.
2. Pass its complete `proof_token` unchanged to a tool named in `Next:`, using the linked inputs shown.
3. Follow each reply’s next-call guidance. Keep both tokens for independent branches that later join.
4. Stop at `This flow is finished.`

> [!TIP]
> Call `baton_status` only when the reply’s next-call guidance is insufficient.

Refusals include an error code and instructions to continue.

### Meta tools

| Core | MCP tool | Returns |
| --- | --- | --- |
| `flow.status` | `baton_status` | Completions, evidence, next inputs, remaining token lifetime |
| `flow.list` | `baton_list` | Tool graph and entry tools |
| `flow.refresh` | `baton_refresh` | Renewed token within `grace`; prerequisite lifetimes stay unchanged |

Each accepts a token or compatible token array through `proof_token`. Status and list require an unexpired token. Expired prerequisites must run again. With `namespace: "docs"`, meta-tool names use the `baton_docs_` prefix.

## Limits

> [!IMPORTANT]
> Proof records a completed handler call. Your handler decides what counts as success. A refused call does not run the handler or issue proof.

- Tokens carry state and can be replayed until expiry. Issuing a new token does not revoke old ones.
- Your application checks whether an artifact is still current and prevents duplicate side effects.
- Linked values are readable in the token. Keep secrets out of them.

## Versioning

During `0.x`, breaking changes bump the minor version and compatible fixes bump the patch. From `1.0.0`, releases follow [SemVer](https://semver.org/).

## Changelog

### 0.1.0 - 2026-10-23

- Initial release.

[MIT license](LICENSE). [Report a bug](https://github.com/superaligned-to/baton/issues).
