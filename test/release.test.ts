import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflow = z
  .object({
    jobs: z.object({
      publish: z.object({
        steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
      }),
    }),
  })
  .parse(parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")));

const steps = workflow.jobs.publish.steps;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const script = (name: string): string => {
  const source = steps.find((step) => step.name === name)?.run;

  if (source === undefined) {
    throw new Error(`Missing workflow step: ${name}`);
  }

  return source;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "user.name=Release test",
      "-c",
      "user.email=release@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const fixture = (version = "0.1.0", notes = true) => {
  const cwd = mkdtempSync(join(tmpdir(), "baton-release-"));

  directories.push(cwd);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "@superaligned/baton", version }),
  );
  writeFileSync(
    join(cwd, "CHANGELOG.md"),
    notes ? `# Changelog\n\n## ${version} - 2026-10-23\n\n- A release.\n` : "# Changelog\n",
  );

  const preload = join(cwd, "registry.mjs");

  writeFileSync(
    preload,
    "globalThis.fetch = async () => new Response(process.env.REGISTRY_BODY, { status: Number(process.env.REGISTRY_STATUS) });\n",
  );

  const output = join(cwd, "output");

  git(cwd, "init", "-q");
  writeFileSync(join(cwd, ".git/info/exclude"), "output\n");
  git(cwd, "add", "package.json", "CHANGELOG.md", "registry.mjs");
  git(cwd, "commit", "-qm", "Release fixture");
  git(cwd, "tag", "-a", `v${version}`, "-m", "Release fixture");

  return {
    cwd,

    run(name: string, extra: Record<string, string> = {}) {
      writeFileSync(output, "");

      const source = /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/.exec(script(name))?.[1];

      if (source === undefined) {
        throw new Error(`Missing Node block: ${name}`);
      }

      return spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-"], {
        cwd,
        input: source,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REF_NAME: `v${version}`,
          RUNNER_TEMP: cwd,
          GITHUB_OUTPUT: output,
          REGISTRY_STATUS: "404",
          REGISTRY_BODY: "",
          PACKED_INTEGRITY: "sha512-checked",
          ...extra,
        },
      });
    },

    output: () => readFileSync(output, "utf8"),
  };
};

describe("inline release workflow", () => {
  const tag = "Verify the release tag and changelog";
  const publication = "Check for an identical previous publication";

  it("requires a matching tag and a clean committed changelog entry", () => {
    const f = fixture();

    expect(f.run(tag).status).toBe(0);
    expect(f.run(tag, { GITHUB_REF_NAME: "v0.2.0" }).status).not.toBe(0);
    writeFileSync(join(f.cwd, "CHANGELOG.md"), "# Changed\n");
    expect(f.run(tag).status).not.toBe(0);
  });

  it("refuses a tag pointing at an earlier commit", () => {
    const f = fixture();

    git(f.cwd, "commit", "--allow-empty", "-qm", "Next commit");
    expect(f.run(tag).status).not.toBe(0);
  });

  it("refuses a clean release without its dated changelog entry", () => {
    const f = fixture("0.1.0", false);

    expect(f.run(tag).status).not.toBe(0);
  });

  it("verifies the bytes of the exact archive that will be published", () => {
    const f = fixture();
    const filename = "checked artifact.tgz";
    const bytes = Buffer.from("checked package archive");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

    writeFileSync(join(f.cwd, filename), bytes);
    writeFileSync(join(f.cwd, "baton-pack.json"), JSON.stringify([{ filename, integrity }]));
    expect(f.run("Pack the checked artifact").status).toBe(0);
    expect(f.output()).toContain(`tarball=${join(f.cwd, filename)}\n`);
    writeFileSync(join(f.cwd, filename), "different archive");
    expect(f.run("Pack the checked artifact").status).not.toBe(0);
  });

  it.each([
    { label: "missing version", status: "404", body: {}, accepted: true, published: false },
    {
      label: "identical publication",
      status: "200",
      body: {
        name: "@superaligned/baton",
        version: "0.1.0",
        dist: { integrity: "sha512-checked" },
      },
      accepted: true,
      published: true,
    },
    {
      label: "different contents",
      status: "200",
      body: { name: "@superaligned/baton", version: "0.1.0", dist: { integrity: "sha512-other" } },
      accepted: false,
    },
    {
      label: "missing integrity",
      status: "200",
      body: { name: "@superaligned/baton", version: "0.1.0", dist: {} },
      accepted: false,
    },
    { label: "registry failure", status: "503", body: {}, accepted: false },
  ])("handles $label before publication", ({ status, body, accepted, published }) => {
    const f = fixture();

    const result = f.run(publication, {
      REGISTRY_STATUS: status,
      REGISTRY_BODY: JSON.stringify(body),
    });

    if (accepted) {
      expect(result.status, result.stderr).toBe(0);
      expect(f.output()).toContain(`published=${published}\n`);
      expect(f.output()).toContain("dist_tag=latest\n");
    } else {
      expect(result.status).not.toBe(0);
      expect(f.output()).toBe("");
    }
  });

  it("uses next for prereleases", () => {
    const f = fixture("0.2.0-beta.1");
    const result = f.run(publication);

    expect(result.status, result.stderr).toBe(0);
    expect(f.output()).toContain("dist_tag=next\n");
  });
});
