#!/usr/bin/env node
// Synthetic X12 837P generator for the streaming parser benchmark.
//
// Emits fully synthetic claims only: no PHI, no real subscriber or provider
// identifiers. Deterministic for a given --seed.
//
// Usage:
//   node bin/generate.mjs --transactions 250000 --claims 4 --out data/claims.x12

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => {
    if (!a.startsWith('--')) return [];
    const next = all[i + 1];
    return [[a.slice(2), next && !next.startsWith('--') ? next : 'true']];
  })
);

const transactions = Number(args.transactions ?? 250_000);
const claimsPerTransaction = Number(args.claims ?? 4);
const seed = Number(args.seed ?? 42);
const out = args.out ?? 'data/claims.x12';

// xorshift32: deterministic, tiny, no dependencies.
let state = seed >>> 0;
const rand = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 0xffffffff;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const digits = (n) => String(Math.floor(rand() * 10 ** n)).padStart(n, '0');
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

const LAST = ['SMITH', 'JOHNSON', 'PATEL', 'GARCIA', 'NGUYEN', 'BROWN', 'KIM', 'MUELLER'];
const FIRST = ['ALEX', 'JAMIE', 'PRIYA', 'DIEGO', 'LINH', 'SAM', 'MORGAN', 'NOOR'];
const CITIES = ['ANAHEIM', 'AUSTIN', 'BOULDER', 'COLUMBUS', 'RENO', 'TAMPA'];
const ICD10 = ['I10', 'E119', 'M5450', 'J069', 'R079', 'Z0000'];
const CPT = ['99213', '99214', '99215', '99385', '99395'];

const isa = (ctrl) =>
  `ISA*00*          *00*          *ZZ*${pad('SYNTHSUB', 15)}*ZZ*${pad('SYNTHRCV', 15)}*260101*1200*^*00501*${digits(9)}*0*P*:~`;
const gs = (ctrl) => `GS*HC*SYNTHSUB*SYNTHRCV*20260101*1200*${ctrl}*X*005010X222A1~`;

function claimSegmentGroup(hlIndex) {
  const last = pick(LAST);
  const first = pick(FIRST);
  const city = pick(CITIES);
  const control = digits(7);
  const charge = (50 + rand() * 950).toFixed(2);
  const icd = pick(ICD10);
  const cpt = pick(CPT);
  return [
    `HL*${hlIndex}*1*22*0~`,
    `SBR*P*18*******CI~`,
    `NM1*IL*1*${last}*${first}****MI*S${digits(8)}~`,
    `N3*${Math.floor(1 + rand() * 999)} ${pick(['MAIN', 'OAK', 'PINE', 'CEDAR'])} STREET~`,
    `N4*${city}*${pick(['CA', 'TX', 'CO', 'OH', 'NV', 'FL'])}*${digits(5)}~`,
    `DMG*D8*${pick(['19481118', '19720325', '19950702', '20010116'])}*${pick(['M', 'F'])}~`,
    `REF*SY*${digits(9)}~`,
    `NM1*PR*2*SYNTHETIC PAYER*****PI*${digits(9)}~`,
    `CLM*SYN${control}*${charge}***11:B:1*Y*A*Y*Y~`,
    `HI*ABK:${icd}~`,
    `LX*1~`,
    `SV1*HC:${cpt}:25*${charge}*UN*1***1:2~`,
    `DTP*472*D8*20260101~`,
  ];
}

function transaction(ctrl) {
  const segments = [
    `ST*837*${digits(4)}*005010X222A1~`,
    `BHT*0019*00*${digits(6)}*20260101*1200*CH~`,
    `NM1*41*2*SYNTHETIC BILLING*****46*${digits(6)}~`,
    `PER*IC*SYNTH CONTACT*TE*${digits(10)}~`,
    `NM1*40*2*SYNTHETIC PAYER*****46*${digits(6)}~`,
    `HL*1**20*1~`,
    `PRV*BI*PXC*207Q00000X~`,
    `NM1*85*1*${pick(LAST)}*${pick(FIRST)}***XX*${digits(10)}~`,
    `N3*${Math.floor(1 + rand() * 999)} ${pick(['ELM', 'MAPLE'])} AVE~`,
    `N4*${pick(CITIES)}*${pick(['CA', 'TX', 'CO'])}*${digits(5)}~`,
    `REF*EI*${digits(9)}~`,
  ];
  for (let i = 0; i < claimsPerTransaction; i++) {
    segments.push(...claimSegmentGroup(i + 2));
  }
  const seCount = segments.length + 1; // ST..SE inclusive
  return [
    ...segments,
    `SE*${seCount}*${digits(4)}~`,
    `GE*1*${ctrl}~`,
    `IEA*1*${digits(9)}~`,
  ];
}

fs.mkdirSync(path.dirname(out), { recursive: true });
const stream = fs.createWriteStream(out);
let bytes = 0;
for (let i = 0; i < transactions; i++) {
  const block = isa(i + 1) + gs(i + 1) + transaction(i + 1).join('');
  bytes += Buffer.byteLength(block);
  if (!stream.write(block)) {
    await new Promise((resolve) => stream.once('drain', resolve));
  }
}
stream.end();
await new Promise((resolve) => stream.once('close', resolve));

console.log(
  JSON.stringify(
    {
      out,
      transactions,
      claims_per_transaction: claimsPerTransaction,
      bytes,
      mb: Number((bytes / 1024 / 1024).toFixed(1)),
      bytes_per_transaction: Math.round(bytes / transactions),
      seed,
    },
    null,
    2
  )
);
