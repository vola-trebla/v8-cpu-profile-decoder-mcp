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
