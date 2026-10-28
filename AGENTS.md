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

Biome checks TypeScript and JSON; markdownlint checks Markdown. Repository tests check package contents, source module size, and YAML, including GitHub workflows and the lockfile.

## Releasing

1. Start from a clean `main`. Update `package.json` with `npm version patch --no-git-tag-version` (or `minor` / `major`), following the README’s versioning policy.
2. Add a dated `## X.Y.Z - YYYY-MM-DD` entry to `CHANGELOG.md` and run `pnpm check`.
3. Commit and push, then create and push the matching annotated `vX.Y.Z` tag.

The `release.yml` workflow requires GitHub Actions and npm trusted publishing. Prereleases use `next`; stable releases use `latest`. An existing version is accepted only if its package integrity matches.
