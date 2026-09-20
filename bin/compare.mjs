#!/usr/bin/env node
// Run every comparison parser against the same file in isolated processes.
//
//   node bin/compare.mjs --file data/claims.x12              # no heap cap
//   node bin/compare.mjs --file data/claims.x12 --cap 25     # 25 MB old-space cap

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => {
    if (!a.startsWith('--')) return [];
    const next = all[i + 1];
    return [[a.slice(2), next && !next.startsWith('--') ? next : 'true']];
  })
);

const file = args.file ?? 'data/claims.x12';
if (!fs.existsSync(file)) {
  console.error(`file not found: ${file}. Generate one with: npm run generate:full`);
  process.exit(1);
}

const cap = args.cap && args.cap !== 'none' ? Number(args.cap) : null;
const parsers = (args.parsers ?? 'stanza,node-x12,x12-parser').split(',');
const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'compare-worker.mjs');

async function run(parser) {
  const nodeArgs = [...(cap ? [`--max-old-space-size=${cap}`] : []), worker, '--parser', parser, '--file', file];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60 * 1000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = null;
      try {
        result = JSON.parse(stdout.trim().split('\n').pop());
      } catch {
        result = null;
      }
      resolve({ parser, code, result, stderr: stderr.trim().split('\n').slice(-3).join('\n') });
    });
  });
}

const results = [];
for (const parser of parsers) {
  results.push(await run(parser));
}

console.log(`file: ${file}, cap: ${cap ? cap + ' MB old space' : 'none'}\n`);
const header = ['parser', 'status', 'wall_ms', 'items', 'peak_heap_mb', 'rss_mb'];
console.log(header.join('\t'));
for (const { parser, code, result, stderr } of results) {
  if (result && !result.error) {
    console.log([parser, 'ok', result.wall_ms, result.items, result.peak_heap_mb, result.rss_mb].join('\t'));
  } else {
    const reason = result?.error ?? (code === 137 || code === 134 ? 'OOM/killed under cap' : `exit ${code}`);
    console.log([parser, `FAILED (${reason})`, '-', '-', '-', '-'].join('\t'));
    if (stderr) console.log(`  ${stderr.split('\n')[0]}`);
  }
}

fs.writeFileSync(
  path.join(path.dirname(file), `compare-${cap ? `cap${cap}` : 'uncapped'}.json`),
  JSON.stringify(results, null, 2) + '\n'
);
