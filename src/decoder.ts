import { readFile } from "fs/promises";
import { CpuProfile, CpuProfileNode, HotFunction, CallTreePath, CallerEntry } from "./types.js";

const V8_INTERNALS = new Set(["(program)", "(garbage collector)", "(idle)", "(root)"]);

function isUserCode(node: CpuProfileNode): boolean {
  if (V8_INTERNALS.has(node.callFrame.functionName)) return false;
  const url = node.callFrame.url;
  if (!url || url.startsWith("node:") || url.startsWith("v8:")) return false;
  return true;
}

export async function loadProfile(profilePath: string): Promise<CpuProfile> {
  const raw = await readFile(profilePath, "utf-8");
  const profile = JSON.parse(raw) as CpuProfile;
  if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) {
    throw new Error("Invalid .cpuprofile: missing nodes or samples arrays");
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

export function extractHottestFunctions(
  profile: CpuProfile,
  topN: number,
  minSelfPercent: number,
  includeNodeInternals: boolean
): HotFunction[] {
  const nodeMap = buildNodeMap(profile);
  const avgMs = avgDeltaMs(profile);
  const totalMs = (profile.endTime - profile.startTime) / 1000;

  const selfTimeMs = new Map<number, number>();
  for (const node of profile.nodes) {
    selfTimeMs.set(node.id, node.hitCount * avgMs);
  }

  const inclusiveCache = new Map<number, number>();
  const childIds = new Set(profile.nodes.flatMap((n) => n.children ?? []));
  const rootIds = profile.nodes.filter((n) => !childIds.has(n.id)).map((n) => n.id);
  for (const rootId of rootIds) {
    computeInclusiveTime(rootId, nodeMap, selfTimeMs, inclusiveCache);
  }

  const results: HotFunction[] = [];
  let rank = 1;

  const sorted = [...profile.nodes].sort(
    (a, b) => (selfTimeMs.get(b.id) ?? 0) - (selfTimeMs.get(a.id) ?? 0)
  );

  for (const node of sorted) {
    if (!includeNodeInternals && !isUserCode(node)) continue;
    const selfMs = selfTimeMs.get(node.id) ?? 0;
    const selfPct = totalMs > 0 ? (selfMs / totalMs) * 100 : 0;
    if (selfPct < minSelfPercent) continue;

    results.push({
      rank: rank++,
      functionName: node.callFrame.functionName || "(anonymous)",
      url: node.callFrame.url,
      lineNumber: node.callFrame.lineNumber,
      columnNumber: node.callFrame.columnNumber,
      selfTimeMs: Math.round(selfMs * 100) / 100,
      totalTimeMs: Math.round((inclusiveCache.get(node.id) ?? selfMs) * 100) / 100,
      selfPercent: Math.round(selfPct * 100) / 100,
      totalPercent:
        totalMs > 0
          ? Math.round(((inclusiveCache.get(node.id) ?? selfMs) / totalMs) * 10000) / 100
          : 0,
      hitCount: node.hitCount,
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
      functionName: entry.node.callFrame.functionName || "(anonymous)",
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
