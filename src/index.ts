#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { loadProfile, extractHottestFunctions, analyzeCallTreePath } from "./decoder.js";
import { correlateSourceCode } from "./sourcemap.js";

const server = new McpServer({
  name: "v8-cpu-profile-decoder-mcp",
  version: "0.1.0",
});

function errorResponse(err: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}

server.registerTool(
  "extract_hottest_functions",
  {
    description:
      "Parses a V8 .cpuprofile file and returns the top N functions ranked by exclusive CPU time (self time). " +
      "Filters out V8 internals and Node.js built-ins by default, returning only user code. " +
      "Use this first to identify which functions are consuming the most CPU in a Node.js performance profile.",
    inputSchema: {
      profile_path: z.string().describe("Absolute path to the .cpuprofile file"),
      top_n: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of hottest functions to return (default: 10)"),
      min_self_percent: z
        .number()
        .min(0)
        .max(100)
        .default(0.5)
        .describe("Minimum self time percentage to include a function (default: 0.5%)"),
      include_node_internals: z
        .boolean()
        .default(false)
        .describe("Include V8 internals and Node.js built-ins in results (default: false)"),
    },
  },
  async ({ profile_path, top_n, min_self_percent, include_node_internals }) => {
    try {
      const profile = await loadProfile(profile_path);
      const result = extractHottestFunctions(
        profile,
        top_n,
        min_self_percent,
        include_node_internals
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "analyze_call_tree_path",
  {
    description:
      "Finds all callers of a specific function in a V8 CPU profile and returns how often each caller invoked it. " +
      "Accepts partial, case-insensitive function name matching. " +
      "Use to answer: what is calling my slow function and how many times?",
    inputSchema: {
      profile_path: z.string().describe("Absolute path to the .cpuprofile file"),
      function_name: z
        .string()
        .describe("Function name to search for (partial match, case-insensitive)"),
      top_callers: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Number of top callers to return (default: 5)"),
    },
  },
  async ({ profile_path, function_name, top_callers }) => {
    try {
      const profile = await loadProfile(profile_path);
      const result = analyzeCallTreePath(profile, function_name, top_callers);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "correlate_source_code",
  {
    description:
      "Maps the hottest functions in a V8 CPU profile back to their original TypeScript source locations " +
      "using source map files (.js.map). Falls back to compiled JS locations if no source map is found. " +
      "Use to answer: which TypeScript file and line is the bottleneck actually coming from?",
    inputSchema: {
      profile_path: z.string().describe("Absolute path to the .cpuprofile file"),
      top_n: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of hottest functions to resolve (default: 10)"),
      sourcemap_dir: z
        .string()
        .optional()
        .describe(
          "Override directory to search for .map files (default: same directory as .js file)"
        ),
    },
  },
  async ({ profile_path, top_n, sourcemap_dir }) => {
    try {
      const profile = await loadProfile(profile_path);
      const result = await correlateSourceCode(profile, top_n, sourcemap_dir ?? null);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
