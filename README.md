# baton

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/superaligned-to/baton/main/.github/media/logo-dark.svg">
    <img src="https://raw.githubusercontent.com/superaligned-to/baton/main/.github/media/logo.svg" alt="baton" height="144">
  </picture>
</p>

**Enforce tool dependencies without building another agent framework.**

Agents can skip steps. Your tools don’t have to let them.

Require a read before an edit, or tests and review before a release. Baton wraps your existing handlers and checks signed proof before each protected call. Link outputs to inputs so the artifact you publish is the one you checked.

<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/superaligned-to/baton/main/.github/media/workflow.png">
    <img src="https://raw.githubusercontent.com/superaligned-to/baton/main/.github/media/workflow.gif" alt="Agents share an MCP server that requires build, test, and review before publishing." width="1040">
  </picture>
</p>

## Install

```sh
pnpm add @superaligned/baton
export BATON_SECRET="$(openssl rand -base64 32)"
```

Requires Node 24+. Use the same secret in every process serving a flow. Changing it invalidates existing tokens.

## API

Create a flow with `baton({ name, secret })` from `@superaligned/baton`. Wrap each handler with `flow.step(name, options).description(text).func(handler)`. Declare every step and branch before calling a tool; the flow is fixed once execution starts. Steps without prerequisites start a new run. An explicitly locked step needs a prerequisite.

| Flow option | Meaning |
| --- | --- |
| `name` | Flow identity carried in tokens |
| `secret` | HMAC key of at least 32 bytes |
| `mcp` | Return MCP results and text refusals; default `false` |
| `namespace` | Separate meta-tool names when flows share a server |
| `grace` | Refresh window after token expiry, in seconds; default `86400` |
| `now` | Clock returning Unix seconds; useful in tests |

| Step option | Meaning |
| --- | --- |
| `from` | Inputs that must match selected outputs from prerequisite steps |
| `ttl` | Evidence lifetime in seconds; default `900` |
| `locked` | Enforce prerequisites; defaults to `true` when dependencies exist |

`.dependsOn(first, ...others)` requires all named steps. `from` also declares prerequisites and binds inputs to values selected with `step.output(selector)`. Select from the handler result, or its `structuredContent` for MCP handlers. Only selected values become signed evidence.

Linked values must have compatible types and match at runtime. They must be finite, acyclic JSON data. Normalize producer outputs before linking them to schemas that normalize inputs.

`.branch({ when, pass, fail })` permits one next call based on the handler result. Return ordinary data such as `passed: false` to permit a retry. Rerunning an earlier step clears downstream evidence in the new token. Existing tokens remain valid until expiry.

Independent checks can share one starting token. Pass their returned tokens together to a step that depends on both. Tokens must belong to the same run with compatible histories.

Handles expose `name`, `description`, `func`, `output`, and `branch`; the handle itself is callable. Zod handles also expose `schema`.

Plain replies contain `result`, `proof_token`, and `next`. Refusals throw `BatonError` with a `code`. Explicitly setting `locked: false` permits a handler to run without valid prerequisites, returning a `warning` and no usable proof.

## MCP

For a server using Zod 4 schemas, import `baton` from `@superaligned/baton/zod` and set `mcp: true`. The core also supports MCP replies when your host supplies its own schemas.

Pass application fields to `.schema(shape)`; baton adds `proof_token`. Register each handle’s `name`, `description`, `schema`, and `func` with your existing server. Register `flow.metaTools()` the same way. Your transport and ungated tools stay as they are.

Handlers return normal MCP results. An `isError: true` result produces no completion evidence. Refusals return `isError: true` with `code: message` text.

## Calling gated tools

Call an entry tool, then pass its complete `proof_token` unchanged to a tool named in `Next:`, using the linked inputs shown. Follow each reply’s next-call guidance. Keep both tokens when taking independent branches that later join. `This flow is finished.` marks completion.

The readable token header names the completed step and permitted next calls. The server verifies its signature when used. `baton_status` is only needed when the reply’s guidance is insufficient.

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

The core exposes `flow.status`, `flow.list`, and `flow.refresh`, each accepting a token or compatible token array through `proof_token`. The Zod adapter’s meta tools are `baton_status`, `baton_list`, and `baton_refresh`. A namespace such as `docs` makes them `baton_docs_status`, `baton_docs_list`, and `baton_docs_refresh`.

Status returns completions, evidence, next inputs, and remaining token lifetime. List returns the tool graph and entry tools. Both require an unexpired token. Refresh accepts authentic expired tokens within `grace`; it renews the token without extending prerequisite lifetimes. Expired prerequisites must run again.

## Limits

Proof records that a handler completed. Your handler decides what counts as success. A refused call does not run the handler or issue proof.

Tokens carry the state and can be replayed until expiry. There is no revocation list. Your application checks whether an artifact is still current and protects duplicate side effects. Linked values are readable in the token; keep secrets out of them.

## Versioning

During `0.x`, breaking changes bump the minor version and compatible fixes bump the patch. From `1.0.0`, releases follow [SemVer](https://semver.org/).

From a clean `main`, update `package.json` with `npm version patch --no-git-tag-version` (or `minor` / `major`), add a dated [changelog](#changelog) entry, and run `pnpm check`. Commit and push, then create and push the matching annotated `vX.Y.Z` tag.

Publishing uses the `release.yml` workflow and npm trusted publishing. Prereleases use `next`; stable releases use `latest`. An existing version is accepted only if its package integrity matches.

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
