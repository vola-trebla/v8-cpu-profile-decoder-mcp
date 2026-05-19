#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import {
  loadProfile,
  extractHottestFunctions,
  analyzeCallTreePath,
  analyzeGcPressure,
  diffProfiles,
} from './decoder.js';
import { correlateSourceCode } from './sourcemap.js';

const server = new McpServer({
  name: 'v8-cpu-profile-decoder-mcp',
  version: '0.2.0',
});

function errorResponse(err: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}

server.registerTool(
  'extract_hottest_functions',
  {
    description:
      'Parses a V8 .cpuprofile file and returns the top N functions ranked by exclusive CPU time (self time). ' +
      'Filters out V8 internals and Node.js built-ins by default, returning only user code. ' +
      'Framework frames (express, next.js, koa, etc.) can be collapsed into a single entry. ' +
      'Recursive calls to the same source location are merged with an instanceCount field. ' +
      'Use this first to identify which functions are consuming the most CPU in a Node.js performance profile.',
    inputSchema: {
      profile_path: z.string().describe('Absolute path to the .cpuprofile file'),
      top_n: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of hottest functions to return (default: 10)'),
      min_self_percent: z
        .number()
        .min(0)
        .max(100)
        .default(0.5)
        .describe('Minimum self time percentage to include a function (default: 0.5%)'),
      include_node_internals: z
        .boolean()
        .default(false)
        .describe('Include V8 internals and Node.js built-ins in results (default: false)'),
      collapse_frameworks: z
        .boolean()
        .default(true)
        .describe(
          'Collapse all frames from known frameworks (express, next.js, koa, fastify, nestjs, react, vue, nuxt, hapi) ' +
            'into a single "<framework> internals>" entry per framework. ' +
            'Prevents dozens of small framework entries from diluting the top-N list (default: true)'
        ),
      collapse_recursion: z
        .boolean()
        .default(true)
        .describe(
          'Merge multiple nodes with the same source location (functionName + url + line + column) into one entry. ' +
            'instanceCount shows how many recursive instances were merged (default: true)'
        ),
    },
  },
  async ({
    profile_path,
    top_n,
    min_self_percent,
    include_node_internals,
    collapse_frameworks,
    collapse_recursion,
  }) => {
    try {
      const profile = await loadProfile(profile_path);
      const result = extractHottestFunctions(
        profile,
        top_n,
        min_self_percent,
        include_node_internals,
        collapse_frameworks,
        collapse_recursion
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'analyze_call_tree_path',
  {
    description:
      'Finds all callers of a specific function in a V8 CPU profile and returns how often each caller invoked it. ' +
      'Accepts partial, case-insensitive function name matching. ' +
      'Use to answer: what is calling my slow function and how many times?',
    inputSchema: {
      profile_path: z.string().describe('Absolute path to the .cpuprofile file'),
      function_name: z
        .string()
        .describe('Function name to search for (partial match, case-insensitive)'),
      top_callers: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe('Number of top callers to return (default: 5)'),
    },
  },
  async ({ profile_path, function_name, top_callers }) => {
    try {
      const profile = await loadProfile(profile_path);
      const result = analyzeCallTreePath(profile, function_name, top_callers);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'correlate_source_code',
  {
    description:
      'Maps the hottest functions in a V8 CPU profile back to their original TypeScript source locations ' +
      'using source map files (.js.map). Falls back to compiled JS locations if no source map is found. ' +
      'Use to answer: which TypeScript file and line is the bottleneck actually coming from?',
    inputSchema: {
      profile_path: z.string().describe('Absolute path to the .cpuprofile file'),
      top_n: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of hottest functions to resolve (default: 10)'),
      sourcemap_dir: z
        .string()
        .optional()
        .describe(
          'Override directory to search for .map files (default: same directory as .js file)'
        ),
    },
  },
  async ({ profile_path, top_n, sourcemap_dir }) => {
    try {
      const profile = await loadProfile(profile_path);
      const result = await correlateSourceCode(profile, top_n, sourcemap_dir ?? null);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'analyze_gc_pressure',
  {
    description:
      'Analyses a V8 .cpuprofile for garbage collection overhead. ' +
      'Reports total GC time as a percentage of profiling duration, broken down by GC type ' +
      '(Scavenger = short-lived object pressure, Mark-Sweep/Mark-Compact = old-space pressure, ' +
      'Incremental = high allocation rate). ' +
      'Flags when GC exceeds a configurable threshold and provides a targeted recommendation. ' +
      'Use to answer: is GC the bottleneck, and what kind of allocation pattern is causing it?',
    inputSchema: {
      profile_path: z.string().describe('Absolute path to the .cpuprofile file'),
      threshold_percent: z
        .number()
        .min(0)
        .max(100)
        .default(10)
        .describe(
          'GC percentage above which exceeds_threshold is set to true and a warning is emitted (default: 10)'
        ),
    },
  },
  async ({ profile_path, threshold_percent }) => {
    try {
      const profile = await loadProfile(profile_path);
      const result = analyzeGcPressure(profile, threshold_percent);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'diff_profiles',
  {
    description:
      'Compares two V8 .cpuprofile files (before and after an optimization) and returns per-function ' +
      "CPU time deltas, normalized against each profile's total duration. " +
      'Frames are matched by call-frame coordinates (functionName + url + line + column), ' +
      'not by transient node IDs, so alignment is stable across profiling sessions. ' +
      'Use to answer: which functions improved or regressed after my change, and by how much?',
    inputSchema: {
      before_profile_path: z.string().describe('Absolute path to the baseline .cpuprofile file'),
      after_profile_path: z
        .string()
        .describe(
          'Absolute path to the optimized .cpuprofile file to compare against the baseline'
        ),
      top_n: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe('Number of top improvements and regressions to return (default: 5)'),
    },
  },
  async ({ before_profile_path, after_profile_path, top_n }) => {
    try {
      const [before, after] = await Promise.all([
        loadProfile(before_profile_path),
        loadProfile(after_profile_path),
      ]);
      const result = diffProfiles(before, after, top_n);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
