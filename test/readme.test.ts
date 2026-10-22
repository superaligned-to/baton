import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

const base = "https://github.com/superaligned-to/baton/blob/main/";

const raw = "https://raw.githubusercontent.com/superaligned-to/baton/main/";

describe("documentation links", () => {
  it("keeps README, agent, and discovery links reachable", () => {
    for (const file of ["README.md", "AGENTS.md", "llms.txt"]) {
      const content = readFileSync(join(root, file), "utf8");
      const links = [...content.matchAll(/\]\(([^)\s]+)\)|(?:src|srcset)="([^"]+)"/g)];

      for (const match of links) {
        const link = match[1] ?? match[2] ?? "";

        const local = link.startsWith(base)
          ? link.slice(base.length)
          : link.startsWith(raw)
            ? link.slice(raw.length)
            : link.includes("://") || link.startsWith("#")
              ? undefined
              : join(file, "..", link);

        if (local !== undefined) {
          expect(existsSync(join(root, local.split("#")[0] ?? "")), link).toBe(true);
        }
      }
    }
  });
});
