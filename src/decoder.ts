import { readFile } from 'fs/promises';
import {
  CpuProfile,
  CpuProfileNode,
  HotFunction,
  CallTreePath,
  CallerEntry,
  GcTypeBreakdown,
  GcPressureResult,
  DiffEntry,
  DiffResult,
  AsyncPatternName,
  AsyncPattern,
  AsyncBottleneckResult,
} from './types.js';

const V8_INTERNALS = new Set(['(program)', '(garbage collector)', '(idle)', '(root)']);

const BUILTIN_PREFIXES = [
  'Builtin: ',
  'LazyCompile: ',
  'BytecodeHandler: ',
  'StubCall: ',
  'RegExp: ',
  'InterpretedFrame: ',
];

const FRAMEWORK_LABELS: [RegExp, string][] = [
  [/node_modules\/express\//, 'express'],
  [/node_modules\/next\//, 'next.js'],
  [/node_modules\/koa\//, 'koa'],
  [/node_modules\/fastify\//, 'fastify'],
  [/node_modules\/@nestjs\//, 'nestjs'],
  [/node_modules\/react(?:-dom)?\//, 'react'],
  [/node_modules\/vue\//, 'vue'],
  [/node_modules\/@nuxt\/|node_modules\/nuxt\//, 'nuxt'],
  [/node_modules\/hapi\/|node_modules\/@hapi\//, 'hapi'],
];

function detectFramework(url: string): string | null {
  for (const [pattern, label] of FRAMEWORK_LABELS) {
    if (pattern.test(url)) return label;
  }
  return null;
}

function isUserCode(node: CpuProfileNode): boolean {
  if (V8_INTERNALS.has(node.callFrame.functionName)) return false;
  if (BUILTIN_PREFIXES.some((p) => node.callFrame.functionName.startsWith(p))) return false;
  const url = node.callFrame.url;
  if (!url || url.startsWith('node:') || url.startsWith('v8:')) return false;
  return true;
}

export async function loadProfile(profilePath: string): Promise<CpuProfile> {
  const raw = await readFile(profilePath, 'utf-8');
  const profile = JSON.parse(raw) as CpuProfile;
  if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) {
    throw new Error('Invalid .cpuprofile: missing nodes or samples arrays');
  }
  return profile;
}

function buildNodeMap(profile: CpuProfile): Map<number, CpuProfileNode> {
  const map = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) map.set(node.id, node);
  return map;
}

function avgDeltaMs(profile: CpuProfile): number {
  const deltas = profile.timeDeltas.slice(1); // timeDeltas[0] is always 0 per V8 spec
  if (deltas.length === 0) return 0;
  return deltas.reduce((a, b) => a + b, 0) / deltas.length / 1000;
}

function computeInclusiveTime(
  nodeId: number,
  nodeMap: Map<number, CpuProfileNode>,
  selfTimeMs: Map<number, number>,
  cache: Map<number, number>
): number {
  if (cache.has(nodeId)) return cache.get(nodeId)!;
  const node = nodeMap.get(nodeId);
  if (!node) return 0;
  let total = selfTimeMs.get(nodeId) ?? 0;
  for (const childId of node.children ?? []) {
    total += computeInclusiveTime(childId, nodeMap, selfTimeMs, cache);
  }
  cache.set(nodeId, total);
  return total;
}

interface AggregatedEntry {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  selfTimeMs: number;
  inclusiveTimeMs: number;
  hitCount: number;
  instanceCount: number;
  frameworkLabel: string | null;
}

function aggregateNodes(
  nodes: CpuProfileNode[],
  selfTimeMsMap: Map<number, number>,
  inclusiveCache: Map<number, number>,
  collapseFrameworks: boolean,
  collapseRecursion: boolean
): AggregatedEntry[] {
  const groups = new Map<string, AggregatedEntry>();

  for (const node of nodes) {
    const cf = node.callFrame;
    const selfMs = selfTimeMsMap.get(node.id) ?? 0;
    const inclusiveMs = inclusiveCache.get(node.id) ?? selfMs;

    let key: string;
    let functionName: string;
    let url: string;
    let lineNumber: number;
    let columnNumber: number;
    let frameworkLabel: string | null = null;

    const fw = collapseFrameworks ? detectFramework(cf.url) : null;
    if (fw) {
      key = `__fw:${fw}`;
      functionName = `<${fw} internals>`;
      url = cf.url;
      lineNumber = 0;
      columnNumber = 0;
      frameworkLabel = fw;
    } else if (collapseRecursion) {
      key = `${cf.functionName}|${cf.url}|${cf.lineNumber}|${cf.columnNumber}`;
      functionName = cf.functionName;
      url = cf.url;
      lineNumber = cf.lineNumber;
      columnNumber = cf.columnNumber;
    } else {
      key = String(node.id);
      functionName = cf.functionName;
      url = cf.url;
      lineNumber = cf.lineNumber;
      columnNumber = cf.columnNumber;
    }

    const existing = groups.get(key);
    if (existing) {
      existing.selfTimeMs += selfMs;
      // inclusive time is not additive across tree positions — keep max for single entries,
      // use selfTimeMs for aggregated ones (set after grouping below)
      existing.inclusiveTimeMs += inclusiveMs;
      existing.hitCount += node.hitCount;
      existing.instanceCount++;
    } else {
      groups.set(key, {
        functionName,
        url,
        lineNumber,
        columnNumber,
        selfTimeMs: selfMs,
        inclusiveTimeMs: inclusiveMs,
        hitCount: node.hitCount,
        instanceCount: 1,
        frameworkLabel,
      });
    }
  }

  // For entries merged from multiple nodes, inclusive time is not well-defined —
  // fall back to selfTimeMs to avoid misleading sums across unrelated subtrees.
  for (const entry of groups.values()) {
    if (entry.instanceCount > 1) {
      entry.inclusiveTimeMs = entry.selfTimeMs;
    }
  }

  return [...groups.values()];
}

export function extractHottestFunctions(
  profile: CpuProfile,
  topN: number,
  minSelfPercent: number,
  includeNodeInternals: boolean,
  collapseFrameworks: boolean,
  collapseRecursion: boolean
): HotFunction[] {
  const nodeMap = buildNodeMap(profile);
  const avgMs = avgDeltaMs(profile);
  const totalMs = (profile.endTime - profile.startTime) / 1000;

  const selfTimeMsMap = new Map<number, number>();
  for (const node of profile.nodes) {
    selfTimeMsMap.set(node.id, node.hitCount * avgMs);
  }

  const inclusiveCache = new Map<number, number>();
  const childIds = new Set(profile.nodes.flatMap((n) => n.children ?? []));
  const rootIds = profile.nodes.filter((n) => !childIds.has(n.id)).map((n) => n.id);
  for (const rootId of rootIds) {
    computeInclusiveTime(rootId, nodeMap, selfTimeMsMap, inclusiveCache);
  }

  const eligible = profile.nodes.filter((n) => (includeNodeInternals ? true : isUserCode(n)));

  const aggregated = aggregateNodes(
    eligible,
    selfTimeMsMap,
    inclusiveCache,
    collapseFrameworks,
    collapseRecursion
  );

  const sorted = aggregated.sort((a, b) => b.selfTimeMs - a.selfTimeMs);

  const results: HotFunction[] = [];
  let rank = 1;

  for (const entry of sorted) {
    const selfPct = totalMs > 0 ? (entry.selfTimeMs / totalMs) * 100 : 0;
    if (selfPct < minSelfPercent) continue;

    results.push({
      rank: rank++,
      functionName: entry.functionName || '(anonymous)',
      url: entry.url,
      lineNumber: entry.lineNumber,
      columnNumber: entry.columnNumber,
      selfTimeMs: Math.round(entry.selfTimeMs * 100) / 100,
      totalTimeMs: Math.round(entry.inclusiveTimeMs * 100) / 100,
      selfPercent: Math.round(selfPct * 100) / 100,
      totalPercent: totalMs > 0 ? Math.round((entry.inclusiveTimeMs / totalMs) * 10000) / 100 : 0,
      hitCount: entry.hitCount,
      instanceCount: entry.instanceCount,
      frameworkLabel: entry.frameworkLabel,
    });

    if (results.length >= topN) break;
  }

  return results;
}

export function analyzeCallTreePath(
  profile: CpuProfile,
  functionName: string,
  topCallers: number
): CallTreePath {
  const nodeMap = buildNodeMap(profile);
  const avgMs = avgDeltaMs(profile);
  const totalMs = (profile.endTime - profile.startTime) / 1000;

  const needle = functionName.toLowerCase();
  const targetIds = new Set(
    profile.nodes
      .filter((n) => n.callFrame.functionName.toLowerCase().includes(needle))
      .map((n) => n.id)
  );

  if (targetIds.size === 0) {
    return {
      targetFunction: functionName,
      matchedNodes: 0,
      totalSelfTimeMs: 0,
      totalPercent: 0,
      callers: [],
    };
  }

  const parentMap = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) {
    for (const childId of node.children ?? []) {
      parentMap.set(childId, node);
    }
  }

  const callerAgg = new Map<number, { node: CpuProfileNode; sampleCount: number }>();
  for (const targetId of targetIds) {
    const parent = parentMap.get(targetId);
    if (!parent) continue;
    const existing = callerAgg.get(parent.id);
    if (existing) {
      existing.sampleCount += nodeMap.get(targetId)?.hitCount ?? 0;
    } else {
      callerAgg.set(parent.id, {
        node: parent,
        sampleCount: nodeMap.get(targetId)?.hitCount ?? 0,
      });
    }
  }

  const totalSelfMs = [...targetIds].reduce(
    (sum, id) => sum + (nodeMap.get(id)?.hitCount ?? 0) * avgMs,
    0
  );

  const callers: CallerEntry[] = [...callerAgg.values()]
    .sort((a, b) => b.sampleCount - a.sampleCount)
    .slice(0, topCallers)
    .map((entry) => ({
      functionName: entry.node.callFrame.functionName || '(anonymous)',
      url: entry.node.callFrame.url,
      lineNumber: entry.node.callFrame.lineNumber,
      sampleCount: entry.sampleCount,
      attributedTimeMs: Math.round(entry.sampleCount * avgMs * 100) / 100,
    }));

  return {
    targetFunction: functionName,
    matchedNodes: targetIds.size,
    totalSelfTimeMs: Math.round(totalSelfMs * 100) / 100,
    totalPercent: totalMs > 0 ? Math.round((totalSelfMs / totalMs) * 10000) / 100 : 0,
    callers,
  };
}

// GC type detection based on V8 internal frame names present in CPU profiles.
// Each pattern matches frames that appear as children of (garbage collector) or
// as standalone GC phase nodes when the profiler has enough resolution.
const GC_TYPE_PATTERNS: Array<[keyof GcTypeBreakdown, RegExp]> = [
  ['scavenger', /scaveng|newspace\.scavenger|semi.space/i],
  ['mark_compact', /markcompact|mark\w*compact|compactor|compact\.sweep/i],
  ['mark_sweep', /marksweep|mark\w*sweep|sweepspace|sweeping|sweep\.code/i],
  ['incremental', /incrementalmark|incremental\w*marking|incremental\w*compaction/i],
];

function classifyGcNode(functionName: string): keyof GcTypeBreakdown {
  for (const [type, pattern] of GC_TYPE_PATTERNS) {
    if (pattern.test(functionName)) return type;
  }
  return 'generic';
}

export function analyzeGcPressure(profile: CpuProfile, thresholdPercent: number): GcPressureResult {
  // Count from samples array so gc_ticks and total_ticks are always consistent.
  const totalTicks = profile.samples.length;
  const nodeMap = buildNodeMap(profile);
  const breakdown: GcTypeBreakdown = {
    scavenger: 0,
    mark_sweep: 0,
    mark_compact: 0,
    incremental: 0,
    generic: 0,
  };

  for (const sampleId of profile.samples) {
    const node = nodeMap.get(sampleId);
    if (!node) continue;
    const fn = node.callFrame.functionName;
    if (fn === '(garbage collector)') {
      breakdown.generic++;
    } else if (GC_TYPE_PATTERNS.some(([, re]) => re.test(fn))) {
      breakdown[classifyGcNode(fn)]++;
    }
  }

  const gcTicks =
    breakdown.scavenger +
    breakdown.mark_sweep +
    breakdown.mark_compact +
    breakdown.incremental +
    breakdown.generic;

  const gcPct = totalTicks > 0 ? Math.round((gcTicks / totalTicks) * 10000) / 100 : 0;
  const exceedsThreshold = gcPct >= thresholdPercent;

  // Build verdict: identify the dominant GC type for a targeted recommendation.
  let verdict: string;
  if (gcTicks === 0) {
    verdict = 'No GC activity detected in this profile.';
  } else {
    const dominant = (
      ['scavenger', 'mark_sweep', 'mark_compact', 'incremental', 'generic'] as Array<
        keyof GcTypeBreakdown
      >
    ).reduce((a, b) => (breakdown[a] >= breakdown[b] ? a : b));

    const recommendations: Record<keyof GcTypeBreakdown, string> = {
      scavenger:
        'Dominated by Scavenger (short-lived object pressure). ' +
        'Consider object pooling, reusing buffers, or reducing closure captures.',
      mark_sweep:
        'Dominated by Mark-Sweep (old-space pressure). ' +
        'Audit long-lived objects and caches for memory leaks.',
      mark_compact:
        'Dominated by Mark-Compact (heap compaction). ' +
        'Large heap fragmentation — reduce peak allocation bursts.',
      incremental:
        'Dominated by Incremental Marking. ' +
        'Allocation rate is high enough to keep the incremental marker busy — reduce object churn.',
      generic:
        'GC type breakdown unavailable (profile lacks sub-phase frames). ' +
        'Consider reducing overall allocation rate.',
    };

    const status = exceedsThreshold
      ? `GC consumed ${gcPct}% of CPU — exceeds the ${thresholdPercent}% threshold. `
      : `GC consumed ${gcPct}% of CPU. `;

    verdict = status + recommendations[dominant];
  }

  return {
    gc_ticks: gcTicks,
    total_ticks: totalTicks,
    gc_percentage: gcPct,
    gc_type_breakdown: breakdown,
    exceeds_threshold: exceedsThreshold,
    threshold_percent: thresholdPercent,
    verdict,
  };
}

// Build a map from call-frame key → normalised self-time in ms.
// Key uses (functionName|url|lineNumber|columnNumber) — not node ID which is transient.
function buildNormalisedSelfTimeMap(profile: CpuProfile): Map<string, number> {
  const avgMs = avgDeltaMs(profile);
  const map = new Map<string, number>();
  for (const node of profile.nodes) {
    if (node.hitCount === 0) continue;
    if (!isUserCode(node)) continue;
    const cf = node.callFrame;
    const key = `${cf.functionName}|${cf.url}|${cf.lineNumber}|${cf.columnNumber}`;
    map.set(key, (map.get(key) ?? 0) + node.hitCount * avgMs);
  }
  return map;
}

function frameKey(node: CpuProfileNode): string {
  const cf = node.callFrame;
  return `${cf.functionName}|${cf.url}|${cf.lineNumber}|${cf.columnNumber}`;
}

export function diffProfiles(before: CpuProfile, after: CpuProfile, topN: number): DiffResult {
  const beforeDurationMs = (before.endTime - before.startTime) / 1000;
  const afterDurationMs = (after.endTime - after.startTime) / 1000;

  const beforeMap = buildNormalisedSelfTimeMap(before);
  const afterMap = buildNormalisedSelfTimeMap(after);

  const allKeys = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  const improvements: DiffEntry[] = [];
  const regressions: DiffEntry[] = [];
  const onlyInBefore: DiffEntry[] = [];
  const onlyInAfter: DiffEntry[] = [];

  // Reconstruct display info from key (functionName|url|line|col)
  const keyMeta = new Map<string, { functionName: string; url: string; lineNumber: number }>();
  for (const node of [...before.nodes, ...after.nodes]) {
    const k = frameKey(node);
    if (!keyMeta.has(k)) {
      keyMeta.set(k, {
        functionName: node.callFrame.functionName || '(anonymous)',
        url: node.callFrame.url,
        lineNumber: node.callFrame.lineNumber,
      });
    }
  }

  for (const key of allKeys) {
    const bMs = beforeMap.get(key) ?? 0;
    const aMs = afterMap.get(key) ?? 0;
    const meta = keyMeta.get(key)!;

    if (bMs > 0 && aMs === 0) {
      onlyInBefore.push({
        function_name: meta.functionName,
        url: meta.url,
        line_number: meta.lineNumber,
        before_ms: Math.round(bMs * 100) / 100,
        after_ms: 0,
        absolute_diff_ms: Math.round(-bMs * 100) / 100,
        relative_diff_percent: -100,
      });
      continue;
    }
    if (aMs > 0 && bMs === 0) {
      onlyInAfter.push({
        function_name: meta.functionName,
        url: meta.url,
        line_number: meta.lineNumber,
        before_ms: 0,
        after_ms: Math.round(aMs * 100) / 100,
        absolute_diff_ms: Math.round(aMs * 100) / 100,
        relative_diff_percent: Infinity,
      });
      continue;
    }

    const diffMs = aMs - bMs;
    const diffPct = Math.round((diffMs / bMs) * 10000) / 100;
    const entry: DiffEntry = {
      function_name: meta.functionName,
      url: meta.url,
      line_number: meta.lineNumber,
      before_ms: Math.round(bMs * 100) / 100,
      after_ms: Math.round(aMs * 100) / 100,
      absolute_diff_ms: Math.round(diffMs * 100) / 100,
      relative_diff_percent: diffPct,
    };

    if (diffMs < 0) improvements.push(entry);
    else if (diffMs > 0) regressions.push(entry);
  }

  improvements.sort((a, b) => a.absolute_diff_ms - b.absolute_diff_ms);
  regressions.sort((a, b) => b.absolute_diff_ms - a.absolute_diff_ms);
  onlyInBefore.sort((a, b) => b.before_ms - a.before_ms);
  onlyInAfter.sort((a, b) => b.after_ms - a.after_ms);

  const totalDeltaMs = afterDurationMs - beforeDurationMs;

  return {
    before_duration_ms: Math.round(beforeDurationMs * 100) / 100,
    after_duration_ms: Math.round(afterDurationMs * 100) / 100,
    total_execution_delta_ms: Math.round(totalDeltaMs * 100) / 100,
    total_execution_delta_percent:
      beforeDurationMs > 0 ? Math.round((totalDeltaMs / beforeDurationMs) * 10000) / 100 : 0,
    top_improvements: improvements.slice(0, topN),
    top_regressions: regressions.slice(0, topN),
    only_in_before: onlyInBefore.slice(0, topN),
    only_in_after: onlyInAfter.slice(0, topN),
  };
}

// Async overhead detection — V8 internal frame patterns for each category.
// These frames appear as leaf samples when the event loop is processing
// async machinery rather than user code.
const ASYNC_PATTERNS: Array<[AsyncPatternName, RegExp]> = [
  [
    'promise_chains',
    /MicrotaskQueue|RunMicrotasks|PromiseResolve|PromiseFulfill|JSPromise|async_hooks|PromiseReactionJob|v8::Promise/i,
  ],
  ['nexttick_saturation', /nextTick|_tickCallback|processTicksAndRejections|nextTickQueue/i],
  [
    'timer_callbacks',
    /listOnTimeout|processTimers|setImmediate|immediateQueue|_onImmediate|runNextTicks|TimersList/i,
  ],
];

function classifyAsyncFrame(functionName: string): AsyncPatternName | null {
  for (const [pattern, re] of ASYNC_PATTERNS) {
    if (re.test(functionName)) return pattern;
  }
  return null;
}

export function analyzeAsyncBottlenecks(
  profile: CpuProfile,
  thresholdPercent: number
): AsyncBottleneckResult {
  const totalTicks = profile.samples.length;
  const avgMs = avgDeltaMs(profile);
  const nodeMap = buildNodeMap(profile);

  const patternTicks = new Map<AsyncPatternName, number>([
    ['promise_chains', 0],
    ['nexttick_saturation', 0],
    ['timer_callbacks', 0],
  ]);

  for (const sampleId of profile.samples) {
    const node = nodeMap.get(sampleId);
    if (!node) continue;
    const category = classifyAsyncFrame(node.callFrame.functionName);
    if (category) patternTicks.set(category, patternTicks.get(category)! + 1);
  }

  const asyncTicks = [...patternTicks.values()].reduce((a, b) => a + b, 0);
  const overheadMs = Math.round(asyncTicks * avgMs * 100) / 100;
  const overheadPct = totalTicks > 0 ? Math.round((asyncTicks / totalTicks) * 10000) / 100 : 0;

  const dominantPatterns: AsyncPattern[] = [...patternTicks.entries()]
    .filter(([, ticks]) => ticks > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([pattern, ticks]) => ({
      pattern,
      ticks,
      percent: totalTicks > 0 ? Math.round((ticks / totalTicks) * 10000) / 100 : 0,
    }));

  const recommendations: Record<AsyncPatternName, string> = {
    promise_chains:
      'Promise chain overhead is visible in the profile. ' +
      'Consider batching microtasks, using Promise.all() to parallelise I/O, ' +
      'or offloading CPU-bound continuations to worker threads.',
    nexttick_saturation:
      'process.nextTick saturation detected. ' +
      'Callbacks are starving the I/O poll phase — ' +
      'replace hot nextTick chains with setImmediate or batch them into a single tick.',
    timer_callbacks:
      'Timer/immediate callback overhead is significant. ' +
      'Consolidate frequent timers, increase intervals, or replace polling with event-driven I/O.',
  };

  let verdict: string;
  if (asyncTicks === 0) {
    verdict = 'No async event-loop overhead detected in this profile.';
  } else {
    const dominant = dominantPatterns[0];
    const status =
      overheadPct >= thresholdPercent
        ? `Event-loop overhead is ${overheadPct}% of CPU — exceeds the ${thresholdPercent}% threshold. `
        : `Event-loop overhead is ${overheadPct}% of CPU. `;
    verdict = status + recommendations[dominant.pattern];
  }

  return {
    total_ticks: totalTicks,
    async_ticks: asyncTicks,
    event_loop_overhead_ms: overheadMs,
    event_loop_overhead_percent: overheadPct,
    dominant_async_patterns: dominantPatterns,
    verdict,
  };
}
