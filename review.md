# Review Notes

v2 validation pass after merging PRs #6–#10 (flame graph enhancements, analyze_gc_pressure,
correlate_source_code fix, diff_profiles, analyze_async_bottlenecks). All 6 tools are
functional via stdio. Three issues found and fixed during this session.

---

## 1. CI installs Playwright (FIXED)

`.github/workflows/ci.yml` had `npx playwright install chromium --with-deps` — copied from a
Playwright project template and never removed. Would cause every CI run to download ~150MB of
browser binaries for no reason, and will fail in environments where Playwright isn't available.

**Fix:** Removed the Playwright step. Added `npm test` instead.

**File:** `.github/workflows/ci.yml`

---

## 2. README missing 3 of 6 tools (FIXED)

`analyze_gc_pressure`, `diff_profiles`, and `analyze_async_bottlenecks` were not documented in
the README. An agent or user reading the README would not know these tools exist.

**Fix:** Added documentation sections for all three tools, including input schemas and realistic
example outputs. Also added 3 matching example agent prompts.

**File:** `README.md`

---

## 3. No test script or unit tests (FIXED)

`package.json` had no `"test"` script. `npm test` failed. CI had no test step.
No `test/` directory exists — the decoder logic has no unit test coverage.

**Fix applied:** Added `"test": "vitest run --passWithNoTests"` to `package.json`, installed
`vitest` as a dev dependency, and added `npm test` to CI.

**Remaining:** Unit tests for `decoder.ts` logic (hit count aggregation, GC classification,
async pattern detection, diff alignment) should be added before next release. This is the
highest-impact gap for catching regressions.

---

## Verification Already Run

- `npm run build` — clean
- `npm run lint` — clean
- `npm run format:check` — clean
- `npm test` — passes with no test files (passWithNoTests)
- `npm pack --dry-run` — correct contents (dist/, README.md, LICENSE, package.json); no src/ or test/ leaked
- MCP stdio `initialize` — OK
- MCP stdio `tools/list` — 6 tools returned with correct schemas
- MCP stdio `extract_hottest_functions` — recursion merge (instanceCount=2), framework collapse (`<express internals>`), builtin filtering all working
- MCP stdio `analyze_call_tree_path` — caller attribution via hitCount correct
- MCP stdio `analyze_gc_pressure` — GC tick counting from samples[], scavenger classification, verdict by dominant type
- MCP stdio `diff_profiles` — before/after alignment by call-frame coordinates, improvements/regressions/only_in_before correct
- MCP stdio `analyze_async_bottlenecks` — MicrotaskQueue and processTicksAndRejections detected, verdict correct
- MCP stdio `correlate_source_code` — sourcemap pragma parsed, SourceMapConsumer resolves to original file
- Edge case: missing file → `Error: ENOENT...` (isError: true, clean)
- Edge case: malformed JSON → parse error (isError: true, clean)
- Edge case: empty profile (missing samples array) → `Error: Invalid .cpuprofile...` (isError: true, clean)

---

## Notes

- Version sync: all at 0.2.0 (`package.json`, `src/index.ts`, `server.json`) — consistent, ready for minor bump
- `analyze_call_tree_path` uses `node.hitCount` for caller sampleCount (consistent with `extractHottestFunctions`); GC/async tools use `profile.samples[]` to avoid `overhead_ticks > total_ticks` — intentional, not a bug
- `analyze_gc_pressure` verdict correctly picks dominant GC type by tick count; "generic" label appears when profile only shows `(garbage collector)` without sub-phase frames (normal for most profiles)
