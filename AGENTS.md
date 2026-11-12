# AGENTS.md

baton is a TypeScript library for enforcing dependencies between existing tool handlers.

The [README](README.md) contains the integration guide, API, token recovery, and versioning policy. Use its [MCP guide](README.md#mcp) when adding baton to an existing server, and [calling instructions](README.md#calling-gated-tools) when using gated tools.

## Working on baton

- Run `pnpm install --frozen-lockfile`, then `pnpm check`.
- Keep the core free of runtime dependencies. Only the optional Zod adapter uses the application's Zod 4 peer.
- Keep the published files limited to `dist`, with npm's README, license, and package manifest.
- Separate logical code blocks, methods, and test phases with blank lines. Keep source modules at most 500 physical lines. Runtime coverage stays at 100%.
- Use Node 22.9 or later. Tokens begin with `bt1`.
- Update the README and `CHANGELOG.md` when the public API changes. Handler integrations and types are checked by the test suite.
- Keep application servers and tool registration intact; baton wraps handlers.
- Keep secrets in environment variables. Host applications check current state and protect duplicate side effects.

## Guidelines

Code here follows the Superaligned guidelines. Before a change, run `treecode catalog set superaligned-to/guidelines` once, then `treecode resolve general/typescript`, and cite rules by ID in reviews.

- Comments only for what the code cannot show (GEN-CS-001). Delete what the change orphans (GEN-CS-002).
- Explicit public types. No `any`, unchecked casts or non-null assertions (GEN-CS-005); Biome enforces `any` and `!`.
- Smallest change that does the job; no speculative options, helpers or dependencies (GEN-CS-008, GEN-CS-012).
- Test behavior at the public contract, one test per behavior you change (GEN-CS-013).
- Verify with `pnpm check` before calling work done, and name what you skipped (GEN-CS-014, GEN-FL-006).

Biome checks TypeScript and JSON; markdownlint checks Markdown. Repository tests check package contents, source module size, and YAML, including GitHub workflows and the lockfile.

## Releasing

1. Start from a clean `main`. Update `package.json` with `npm version patch --no-git-tag-version` (or `minor` / `major`), following the README’s versioning policy.
2. Add a dated `## X.Y.Z - YYYY-MM-DD` entry to `CHANGELOG.md` and run `pnpm check`.
3. Commit and push, then create and push the matching annotated `vX.Y.Z` tag.

The `release.yml` workflow requires GitHub Actions and npm trusted publishing. Prereleases use `next`; stable releases use `latest`. An existing version is accepted only if its package integrity matches.
