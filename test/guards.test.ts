import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));

const manifest = z
  .record(z.string(), z.unknown())
  .parse(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));

describe("repository constraints", () => {
  it("keeps core dependency-free and Zod an optional adapter peer", () => {
    expect(manifest.dependencies === undefined ? {} : manifest.dependencies).toEqual({});
    expect(
      manifest.optionalDependencies === undefined ? {} : manifest.optionalDependencies,
    ).toEqual({});
    expect(manifest.peerDependencies).toEqual({ zod: "^4.0.0" });
    expect(manifest.peerDependenciesMeta).toEqual({ zod: { optional: true } });

    const scripts = z.record(z.string(), z.string()).parse(manifest.scripts);

    for (const lifecycle of ["preinstall", "install", "postinstall"]) {
      expect(scripts).not.toHaveProperty(lifecycle);
    }
  });

  it("publishes compiled ESM entry points to the public npm registry", () => {
    expect(manifest.files).toEqual(["dist"]);
    expect(manifest.type).toBe("module");
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.engines).toEqual({ node: ">=22.9" });
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./zod": { types: "./dist/zod.d.ts", default: "./dist/zod.js" },
    });
    expect(manifest.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org",
    });
  });

  it("typechecks handler integrations against the published declarations", () => {
    const fixtures = globSync("test/fixtures/*.ts", { cwd: root }).sort();

    const output = execFileSync(
      process.execPath,
      [
        resolve(root, "node_modules/typescript/bin/tsc"),
        "--ignoreConfig",
        "--types",
        "node",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--skipLibCheck",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2023",
        "--noEmit",
        ...fixtures.map((file) => resolve(root, file)),
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(output).toBe("");
  });

  it("packs only compiled runtime files, declarations, and package metadata", () => {
    const packed = z
      .array(z.object({ files: z.array(z.object({ path: z.string() })) }))
      .length(1)
      .parse(
        JSON.parse(
          execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        ),
      );

    const files = packed.flatMap((entry) => entry.files.map((file) => file.path));

    expect(files).toEqual(
      expect.arrayContaining([
        "package.json",
        "README.md",
        "LICENSE",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/zod.js",
        "dist/zod.d.ts",
      ]),
    );

    for (const file of files) {
      expect(file).toMatch(/^(?:package\.json|README\.md|LICENSE|dist\/.+\.(?:js|d\.ts))$/);
      expect(file).not.toMatch(/\.(?:test|spec)\./);
    }
  });

  it("keeps every production module within 500 physical lines", () => {
    const files = globSync("src/**/*.ts", { cwd: root }).filter(
      (file) => !/\.(?:test|spec|d)\.ts$/.test(file),
    );

    expect(files).toContain("src/index.ts");

    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");
      const count =
        source === "" ? 0 : source.split(/\r\n|\n|\r/).length - (/[\r\n]$/.test(source) ? 1 : 0);

      expect(count, file).toBeLessThanOrEqual(500);
    }
  });

  it("parses every YAML file, including workflows and the lockfile", () => {
    const files = globSync(["**/*.yaml", "**/*.yml", "**/.*/**/*.yaml", "**/.*/**/*.yml"], {
      cwd: root,
      exclude: ["node_modules/**", ".git/**", "dist/**", "coverage/**"],
    });

    expect(files).toEqual(
      expect.arrayContaining([
        "pnpm-lock.yaml",
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml",
      ]),
    );

    for (const file of files) {
      const documents = parseAllDocuments(readFileSync(resolve(root, file), "utf8"), {
        version: "1.2",
        strict: true,
        uniqueKeys: true,
      });

      const errors = documents.flatMap((document) => [...document.errors, ...document.warnings]);

      expect(errors, file).toEqual([]);
    }
  });
});
