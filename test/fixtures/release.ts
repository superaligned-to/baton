import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { baton } from "@superaligned/baton/zod";
import { z } from "zod";

const reply = <Data extends Record<string, unknown>>(data: Data) => ({
  structuredContent: data,
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

type Artifact = { packageName: string; content: string; published: boolean };

const configureTools = (secret: string) => {
  const artifacts = new Map<string, Artifact>();
  const flow = baton({ name: "artifact-release", secret, mcp: true });

  const current = (packageName: string, artifact: string): Artifact => {
    const found = artifacts.get(artifact);

    if (found === undefined || found.packageName !== packageName) {
      throw new Error("The artifact is unavailable. Build it again.");
    }

    return found;
  };

  const build = flow
    .step("build_artifact")
    .description("Build an immutable demo package artifact.")
    .schema({ packageName: z.string(), content: z.string() })
    .func(({ packageName, content }) => {
      const artifact = createHash("sha256")
        .update(JSON.stringify([packageName, content]))
        .digest("hex");

      if (!artifacts.has(artifact)) {
        artifacts.set(artifact, { packageName, content, published: false });
      }

      return reply({ packageName, artifact });
    });

  const tests = flow
    .step("test_artifact", {
      from: {
        packageName: build.output((result) => result.structuredContent.packageName),
        artifact: build.output((result) => result.structuredContent.artifact),
      },
    })
    .description("Check the exact artifact for an exported entry point.")
    .schema({ packageName: z.string(), artifact: z.string() })
    .func(({ packageName, artifact }) => {
      if (!current(packageName, artifact).content.includes("export ")) {
        return {
          content: [{ type: "text" as const, text: "The artifact has no exported entry point." }],
          isError: true as const,
        };
      }

      return reply({ packageName, artifact, testsPassed: true });
    });

  const review = flow
    .step("review_artifact", {
      from: {
        packageName: build.output((result) => result.structuredContent.packageName),
        artifact: build.output((result) => result.structuredContent.artifact),
      },
    })
    .description("Check the same artifact for unfinished TODO markers.")
    .schema({ packageName: z.string(), artifact: z.string() })
    .func(({ packageName, artifact }) => {
      if (current(packageName, artifact).content.includes("TODO")) {
        return {
          content: [{ type: "text" as const, text: "The artifact contains an unfinished TODO." }],
          isError: true as const,
        };
      }

      return reply({ packageName, artifact, reviewed: true });
    });

  const publish = flow
    .step("publish_artifact", {
      from: {
        packageName: build.output((result) => result.structuredContent.packageName),
        artifact: build.output((result) => result.structuredContent.artifact),
      },
    })
    .dependsOn(tests, review)
    .description("Record a demo release after both checks completed for this artifact.")
    .schema({ packageName: z.string(), artifact: z.string() })
    .func(({ packageName, artifact }) => {
      const found = current(packageName, artifact);

      if (found.published) {
        throw new Error("This artifact is already published.");
      }

      found.published = true;

      return reply({ packageName, artifact, published: true, registry: "memory" });
    });

  return { flow, build, tests, review, publish };
};

export const createTools = (
  secret = process.env.BATON_SECRET ?? "",
): ReturnType<typeof configureTools> => configureTools(secret);

export const createServer = (secret = process.env.BATON_SECRET ?? ""): McpServer => {
  const { flow, build, tests, review, publish } = createTools(secret);
  const server = new McpServer({ name: "release-tools", version: "0.1.0" });

  server.registerTool(
    build.name,
    { description: build.description, inputSchema: build.schema },
    build.func,
  );
  server.registerTool(
    tests.name,
    { description: tests.description, inputSchema: tests.schema },
    tests.func,
  );
  server.registerTool(
    review.name,
    { description: review.description, inputSchema: review.schema },
    review.func,
  );
  server.registerTool(
    publish.name,
    { description: publish.description, inputSchema: publish.schema },
    publish.func,
  );

  for (const tool of flow.metaTools()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      tool.func,
    );
  }

  return server;
};
