import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { SourceMapConsumer } from 'source-map';
import { CpuProfile, ResolvedFunction, SourceCorrelationResult } from './types.js';
import { extractHottestFunctions } from './decoder.js';

function urlToPath(url: string): string | null {
  if (url.startsWith('file://')) return url.slice(7);
  if (url.startsWith('/')) return url;
  return null;
}

async function resolveSourceLocation(
  url: string,
  line: number,
  column: number,
  sourcemapDir: string | null
): Promise<{ file: string; line: number; column: number; name: string | null } | null> {
  const filePath = urlToPath(url);
  if (!filePath) return null;

  const candidates = [`${filePath}.map`];
  if (sourcemapDir) candidates.push(resolve(sourcemapDir, `${filePath.split('/').pop()}.map`));

  const mapPath = candidates.find((p) => existsSync(p));
  if (!mapPath) return null;

  const rawMap = JSON.parse(await readFile(mapPath, 'utf-8'));
  // V8 lineNumber is 0-based, source-map expects 1-based
  return SourceMapConsumer.with(rawMap, null, (consumer) => {
    const pos = consumer.originalPositionFor({ line: line + 1, column });
    if (!pos.source) return null;
    return { file: pos.source, line: pos.line ?? 0, column: pos.column ?? 0, name: pos.name };
  });
}

export async function correlateSourceCode(
  profile: CpuProfile,
  topN: number,
  sourcemapDir: string | null
): Promise<SourceCorrelationResult> {
  const hotFunctions = extractHottestFunctions(profile, topN, 0, false);
  const errors: string[] = [];

  const resolved = await Promise.all(
    hotFunctions.map(async (fn): Promise<ResolvedFunction> => {
      let source = null;
      if (fn.url) {
        try {
          const loc = await resolveSourceLocation(
            fn.url,
            fn.lineNumber,
            fn.columnNumber,
            sourcemapDir
          );
          if (loc) {
            source = {
              originalFile: loc.file,
              originalLine: loc.line,
              originalColumn: loc.column,
              originalFunction: loc.name,
            };
          }
        } catch (err) {
          errors.push(
            `${fn.url}:${fn.lineNumber} — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return {
        rank: fn.rank,
        generatedUrl: fn.url,
        generatedLine: fn.lineNumber,
        generatedColumn: fn.columnNumber,
        source,
        selfTimeMs: fn.selfTimeMs,
        selfPercent: fn.selfPercent,
      };
    })
  );

  return { resolved, sourcemapErrors: errors };
}
