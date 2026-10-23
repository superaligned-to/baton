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
> The agent makes each call. Baton checks prerequisites before your handler runs.

## Install

Requires **Node 24+**. [Available on npm](https://www.npmjs.com/package/@superaligned/baton).

```sh
pnpm add @superaligned/baton
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
| `now` | Current time | Clock returning Unix seconds |

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

Linked values must have compatible types and match at runtime. Use finite, acyclic JSON data. Normalize producer outputs before linking them to schemas that normalize inputs.

Handles are callable directly and expose `.func`. Zod handles also expose `schema`.

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

Token headers name the completed step and permitted next calls; the server verifies the signature.

> [!TIP]
> Call `baton_status` only when the reply’s next-call guidance is insufficient.

| Refusal | Recovery |
| --- | --- |
| `token_required` | Run the entry or prerequisite named in the message |
| `token_invalid` | Restart the named flow |
| `token_expired` | Refresh the token or restart if its grace period expired |
| `dependency_required` | Complete the missing prerequisite in this run |
| `dependency_expired` | Rerun the expired prerequisite |
| `dependency_conflict` | Use tokens from the same run and compatible history |
| `input_mismatch` | Pass the exact linked value shown |
| `step_out_of_order` | Call a permitted next tool |
| `output_invalid` | Fix the handler’s selected output; it cannot become JSON proof |

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

1. From a clean `main`, update `package.json` with `npm version patch --no-git-tag-version` (or `minor` / `major`) and add a dated [changelog](#changelog) entry.
2. Run `pnpm check`, commit, and push.
3. Create and push the matching annotated `vX.Y.Z` tag.

The `release.yml` workflow requires GitHub Actions and npm trusted publishing to be configured. Prereleases use `next`; stable releases use `latest`. An existing version is accepted only if its package integrity matches.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
```

Checks include lint, types, package contents, and tests with 100% runtime coverage.

## Changelog

### 0.1.0 - 2026-10-23

- Wrap typed handlers with prerequisites, branches, and linked inputs.
- Carry signed completion evidence with per-step expiry.
- Add the optional Zod adapter and `baton_*` meta tools.

[MIT license](LICENSE). [Report a bug](https://github.com/superaligned-to/baton/issues).
