export interface CpuProfileCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface CpuProfileNode {
  id: number;
  callFrame: CpuProfileCallFrame;
  hitCount: number;
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface HotFunction {
  rank: number;
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  selfTimeMs: number;
  totalTimeMs: number;
  selfPercent: number;
  totalPercent: number;
  hitCount: number;
  instanceCount: number;
  frameworkLabel: string | null;
}

export interface CallerEntry {
  functionName: string;
  url: string;
  lineNumber: number;
  sampleCount: number;
  attributedTimeMs: number;
}

export interface CallTreePath {
  targetFunction: string;
  matchedNodes: number;
  totalSelfTimeMs: number;
  totalPercent: number;
  callers: CallerEntry[];
}

export interface SourceLocation {
  originalFile: string;
  originalLine: number;
  originalColumn: number;
  originalFunction: string | null;
}

export interface ResolvedFunction {
  rank: number;
  generatedUrl: string;
  generatedLine: number;
  generatedColumn: number;
  source: SourceLocation | null;
  selfTimeMs: number;
  selfPercent: number;
}

export interface SourceCorrelationResult {
  resolved: ResolvedFunction[];
  sourcemapErrors: string[];
}

export interface DiffEntry {
  function_name: string;
  url: string;
  line_number: number;
  before_ms: number;
  after_ms: number;
  absolute_diff_ms: number;
  relative_diff_percent: number;
}

export interface DiffResult {
  before_duration_ms: number;
  after_duration_ms: number;
  total_execution_delta_ms: number;
  total_execution_delta_percent: number;
  top_improvements: DiffEntry[];
  top_regressions: DiffEntry[];
  only_in_before: DiffEntry[];
  only_in_after: DiffEntry[];
}

export interface GcTypeBreakdown {
  scavenger: number;
  mark_sweep: number;
  mark_compact: number;
  incremental: number;
  generic: number;
}

export interface GcPressureResult {
  gc_ticks: number;
  total_ticks: number;
  gc_percentage: number;
  gc_type_breakdown: GcTypeBreakdown;
  exceeds_threshold: boolean;
  threshold_percent: number;
  verdict: string;
}
