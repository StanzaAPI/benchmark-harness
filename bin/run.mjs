#!/usr/bin/env node
// Benchmark runner: streams a synthetic X12 file through the zero-regex
// streaming parser and reports wall time plus peak sampled heap.
//
// Run under the documented memory ceiling:
//   node --max-old-space-size=25 bin/run.mjs data/claims.x12
//
// The parsed transaction payloads are discarded on purpose; the benchmark
// measures parsing throughput, not retention.

import fs from 'node:fs';
import { Readable } from 'node:stream';

import { iterateX12StreamFrames } from '../dist/services/stream.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node --max-old-space-size=25 bin/run.mjs <file.x12>');
  process.exit(1);
}

const maxRecords = Number(process.env.MAX_RECORDS ?? 10_000_000);
const bytes = fs.statSync(file).size;

let peakHeap = 0;
const sample = setInterval(() => {
  const used = process.memoryUsage().heapUsed;
  if (used > peakHeap) peakHeap = used;
}, 25);

const started = performance.now();
let frames = 0;
let transactions = 0;
let errors = 0;
let summary = null;

const input = Readable.toWeb(fs.createReadStream(file, { highWaterMark: 1 << 20 }));
for await (const frame of iterateX12StreamFrames(input, { maxRecords })) {
  frames++;
  if (frame.startsWith('{"type":"transaction"')) transactions++;
  else if (frame.startsWith('{"type":"summary"')) summary = JSON.parse(frame);
  else errors++;
}

clearInterval(sample);
const durationMs = performance.now() - started;

console.log(
  JSON.stringify(
    {
      file,
      bytes,
      mb: Number((bytes / 1024 / 1024).toFixed(1)),
      frames,
      transactions,
      errors,
      stream_duration_ms: summary?.duration_ms ?? null,
      wall_ms: Number(durationMs.toFixed(1)),
      mb_per_s: Number((bytes / 1024 / 1024 / (durationMs / 1000)).toFixed(1)),
      records_per_s: Math.round(transactions / (durationMs / 1000)),
      peak_heap_used_mb: Number((peakHeap / 1024 / 1024).toFixed(1)),
      rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    },
    null,
    2
  )
);
