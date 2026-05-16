# v8-cpu-profile-decoder-mcp 🐸⚡

[![npm version](https://img.shields.io/npm/v/v8-cpu-profile-decoder-mcp.svg)](https://www.npmjs.com/package/v8-cpu-profile-decoder-mcp)
[![npm downloads](https://img.shields.io/npm/dm/v8-cpu-profile-decoder-mcp.svg)](https://www.npmjs.com/package/v8-cpu-profile-decoder-mcp)
[![CI](https://github.com/vola-trebla/v8-cpu-profile-decoder-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vola-trebla/v8-cpu-profile-decoder-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP server that decodes V8 CPU profiles into **token-efficient bottleneck summaries** for AI agents.

Your Node.js app is slow. You ran `--cpu-prof`. Now you have a 20MB `.cpuprofile` file — and your AI agent is completely blind to it.

---

## 🤔 The Problem

V8 CPU profiles are massive. A typical `.cpuprofile` from a production Node.js app is **5–50MB of raw JSON** — millions of lines mapping memory addresses, tick counts, and microsecond execution sequences. It looks like this:

```json
{
  "nodes": [
    { "id": 1482, "callFrame": { "functionName": "processRequest", "url": "file:///app/dist/server.js", "lineNumber": 847 }, "hitCount": 3241, "children": [1483, 1490] },
    ...
  ],
  "samples": [1482, 1483, 1482, 1490, 1482, ...],
  "timeDeltas": [120, 98, 115, 102, ...]
}
```

An AI agent attempting to read this file **instantly collapses its context window** and fails. Even if it could read it, it can't run the aggregation algorithms needed to compute inclusive/exclusive CPU times across the call tree.

So when you ask your agent:

- 🙈 _"Which function is consuming the most CPU?"_
- 🙈 _"What's calling my slow database query?"_
- 🙈 _"Which TypeScript file is the bottleneck actually coming from?"_

...it's guessing. It has no access to the profiling data.

`v8-cpu-profile-decoder-mcp` fixes that. It decodes the profile locally and hands the agent a **10-line semantic summary** instead of a 50MB file.

---

## 🛠️ Tools

### `extract_hottest_functions`

Parses the `.cpuprofile` and returns the top N functions ranked by exclusive CPU time (self time).
Filters out V8 internals and Node.js built-ins — only user code.

```json
{
  "profile_path": "/app/profiles/CPU.20260516.cpuprofile",
  "top_n": 5,
  "min_self_percent": 1.0
}
```

```json
[
  {
    "rank": 1,
    "functionName": "hashPassword",
    "url": "file:///app/dist/auth/crypto.js",
    "lineNumber": 42,
    "selfTimeMs": 1842.5,
    "totalTimeMs": 1842.5,
    "selfPercent": 61.32,
    "totalPercent": 61.32,
    "hitCount": 3241
  },
  {
    "rank": 2,
    "functionName": "parseJsonBody",
    "url": "file:///app/dist/middleware/body.js",
    "lineNumber": 18,
    "selfTimeMs": 412.1,
    "totalTimeMs": 412.1,
    "selfPercent": 13.71,
    "totalPercent": 13.71,
    "hitCount": 724
  }
]
```

---

### `analyze_call_tree_path`

Finds all callers of a specific function and shows how often each one invoked it.
Accepts partial, case-insensitive function name matching.

```json
{
  "profile_path": "/app/profiles/CPU.20260516.cpuprofile",
  "function_name": "hashPassword",
  "top_callers": 3
}
```

```json
{
  "targetFunction": "hashPassword",
  "matchedNodes": 2,
  "totalSelfTimeMs": 1842.5,
  "totalPercent": 61.32,
  "callers": [
    {
      "functionName": "loginHandler",
      "url": "file:///app/dist/routes/auth.js",
      "lineNumber": 94,
      "callCount": 2180,
      "selfTimeMs": 240.1
    },
    {
      "functionName": "validateSession",
      "url": "file:///app/dist/middleware/auth.js",
      "lineNumber": 31,
      "callCount": 1061,
      "selfTimeMs": 116.8
    }
  ]
}
```

---

### `correlate_source_code`

Maps compiled JS bottlenecks back to their **original TypeScript source locations** using `.js.map` files.
Falls back gracefully to compiled JS locations if no source map is found.

```json
{
  "profile_path": "/app/profiles/CPU.20260516.cpuprofile",
  "top_n": 5
}
```

```json
{
  "resolved": [
    {
      "rank": 1,
      "generatedUrl": "file:///app/dist/auth/crypto.js",
      "generatedLine": 42,
      "source": {
        "originalFile": "src/auth/crypto.ts",
        "originalLine": 38,
        "originalColumn": 2,
        "originalFunction": "hashPassword"
      },
      "selfTimeMs": 1842.5,
      "selfPercent": 61.32
    }
  ],
  "sourcemapErrors": []
}
```

---

## 🚀 Installation

```bash
npx v8-cpu-profile-decoder-mcp
```

Or install globally:

```bash
npm install -g v8-cpu-profile-decoder-mcp
```

### Generate a CPU profile in Node.js

```bash
# Single run
node --cpu-prof your-script.js

# With custom output dir
node --cpu-prof --cpu-prof-dir ./profiles your-script.js
```

Or programmatically via Chrome DevTools → Performance tab → Record.

### Claude Desktop config

```json
{
  "mcpServers": {
    "v8-cpu-profile-decoder-mcp": {
      "command": "npx",
      "args": ["-y", "v8-cpu-profile-decoder-mcp"]
    }
  }
}
```

---

## 💡 Example Agent Prompts

> _"Here's my CPU profile at `/app/profiles/CPU.cpuprofile` — which function is consuming the most CPU?"_

> _"Find what's calling `processRequest` in this profile and how often"_

> _"Map the top 10 hottest functions back to their original TypeScript files"_

> _"My Node.js API is slow under load — profile is at `/tmp/CPU.cpuprofile`, find the bottleneck"_

---

## 🔗 Related Projects

- [playwright-trace-decoder-mcp](https://github.com/vola-trebla/playwright-trace-decoder-mcp) — decode Playwright traces for CI failure root-cause analysis
- [playwright-network-chaos-mcp](https://github.com/vola-trebla/playwright-network-chaos-mcp) — simulate network failures and latency in browser sessions
- [flakiness-knowledge-graph-mcp](https://github.com/vola-trebla/flakiness-knowledge-graph-mcp) — knowledge graph of flaky test patterns
- [ast-impact-mapper-mcp](https://github.com/vola-trebla/ast-impact-mapper-mcp) — find affected tests from code changes via TypeScript AST
- [playwright-spatial-layout-mcp](https://github.com/vola-trebla/playwright-spatial-layout-mcp) — geometric spatial awareness of web layouts

---

## 📄 License

MIT © [vola-trebla](https://github.com/vola-trebla)
