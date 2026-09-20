#!/usr/bin/env node
// Compare worker: runs exactly one parser over one file and prints JSON.
// Spawned by bin/compare.mjs so each parser gets a fresh process and its own
// memory ceiling.

import fs from 'node:fs';
import { Readable } from 'node:stream';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => {
    if (!a.startsWith('--')) return [];
    const next = all[i + 1];
    return [[a.slice(2), next && !next.startsWith('--') ? next : 'true']];
  })
);

const parserName = args.parser;
const file = args.file;
if (!parserName || !file) {
  console.error('usage: node bin/compare-worker.mjs --parser <stanza|node-x12|x12-parser> --file <path>');
  process.exit(1);
}

const bytes = fs.statSync(file).size;
let peakHeap = 0;
const sample = setInterval(() => {
  const used = process.memoryUsage().heapUsed;
  if (used > peakHeap) peakHeap = used;
}, 25);

const started = performance.now();
let items = 0;

try {
  if (parserName === 'stanza') {
    const { iterateX12StreamFrames } = await import('../dist/services/stream.js');
    const input = Readable.toWeb(fs.createReadStream(file, { highWaterMark: 1 << 20 }));
    for await (const _frame of iterateX12StreamFrames(input, { maxRecords: 10_000_000 })) items++;
  } else if (parserName === 'node-x12') {
    const { X12Parser } = await import('node-x12');
    // Lax mode: node-x12's strict streaming parser throws at flush
    // ("must contain at least one functional group") even on a single valid
    // envelope, because its stream path never builds the interchange object
    // model. See COMPARISON.md for the exact reproduction.
    const parser = new X12Parser(false);
    // Parse-only: count data events without retaining segments. The library's
    // documented flow keeps segments to build an interchange at the end, which
    // is a memory decision, not a parsing-cost decision.
    await new Promise((resolve, reject) => {
      fs.createReadStream(file).pipe(parser).on('data', () => items++).on('end', resolve).on('error', reject);
    });
  } else if (parserName === 'x12-parser') {
    const { X12parser } = await import('x12-parser');
    const parser = new X12parser();
    await new Promise((resolve, reject) => {
      fs.createReadStream(file).pipe(parser).on('data', () => items++).on('error', reject).on('end', resolve);
    });
  } else {
    throw new Error(`unknown parser: ${parserName}`);
  }
} catch (err) {
  clearInterval(sample);
  console.log(JSON.stringify({ parser: parserName, file, error: err.message, mb: bytes / 1024 / 1024 }));
  process.exit(1);
}

clearInterval(sample);
console.log(
  JSON.stringify({
    parser: parserName,
    file,
    mb: Number((bytes / 1024 / 1024).toFixed(1)),
    items,
    wall_ms: Number((performance.now() - started).toFixed(1)),
    peak_heap_mb: Number((peakHeap / 1024 / 1024).toFixed(1)),
    rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
  })
);
