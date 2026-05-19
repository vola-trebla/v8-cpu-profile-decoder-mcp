import { existsSync } from 'fs';
import { open, readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { SourceMapConsumer, RawSourceMap } from 'source-map';
import { CpuProfile, ResolvedFunction, SourceCorrelationResult } from './types.js';
import { extractHottestFunctions } from './decoder.js';

function urlToPath(url: string): string | null {
  if (url.startsWith('file://')) return url.slice(7);
  if (url.startsWith('/')) return url;
  return null;
}

// Read only the tail of a (potentially large) JS bundle to find the pragma.
async function readFileTail(filePath: string, bytes = 4096): Promise<string> {
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf-8');
  } finally {
    await fh.close();
  }
}

// Parse sourceMappingURL pragma and return the raw source map object, or null.
// Resolution order:
//   1. //# sourceMappingURL= pragma in the JS file (inline or external)
//   2. Conventional <file>.map alongside the JS file
//   3. sourcemapDir override (filename only, .map appended)
async function loadSourceMap(
  jsFilePath: string,
  sourcemapDir: string | null
): Promise<RawSourceMap | null> {
  // Step 1: parse pragma from JS file tail
  try {
    const tail = await readFileTail(jsFilePath);
    const match = tail.match(/\/\/#\s*sourceMappingURL=([^\s]+)/);
    if (match) {
      const ref = match[1].trim();

      // Inline source map: data:application/json;base64,<b64> or data:...charset=utf-8,...<json>
      if (ref.startsWith('data:application/json;')) {
        const b64Idx = ref.indexOf('base64,');
        if (b64Idx !== -1) {
          const json = Buffer.from(ref.slice(b64Idx + 7), 'base64').toString('utf-8');
          return JSON.parse(json);
        }
        const commaIdx = ref.indexOf(',');
        if (commaIdx !== -1) {
          return JSON.parse(decodeURIComponent(ref.slice(commaIdx + 1)));
        }
      }

      // External reference — resolve relative to the JS file's directory
      const mapPath = resolve(dirname(jsFilePath), ref);
      if (existsSync(mapPath)) {
        return JSON.parse(await readFile(mapPath, 'utf-8'));
      }
      // Pragma found but map file missing — don't fall through to guesses
      return null;
    }
  } catch {}

  // Step 2: conventional <file>.map alongside the JS file
  const conventional = `${jsFilePath}.map`;
  if (existsSync(conventional)) {
    try {
      return JSON.parse(await readFile(conventional, 'utf-8'));
    } catch {}
  }

  // Step 3: sourcemapDir override
  if (sourcemapDir) {
    const name = jsFilePath.split('/').pop()!;
    const overridePath = resolve(sourcemapDir, `${name}.map`);
    if (existsSync(overridePath)) {
      try {
        return JSON.parse(await readFile(overridePath, 'utf-8'));
      } catch {}
    }
  }

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

  const rawMap = await loadSourceMap(filePath, sourcemapDir);
  if (!rawMap) return null;

  // V8 lineNumber is 0-based; source-map consumer expects 1-based
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
  const hotFunctions = extractHottestFunctions(profile, topN, 0, false, false, false);
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
