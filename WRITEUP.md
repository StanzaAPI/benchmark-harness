# What a 25 MB heap cap costs: 49% on node-x12, 21% on x12-parser, 6% on this parser

A 500.5 MB X12 file, 255,000 healthcare claim transactions, parsed in **14.2
seconds inside a hard 25 MB V8 old-space cap**. Under the same cap, the two
established Node X12 libraries slow down: **node-x12 by 49% in wall time,
x12-parser by 21%**. This parser pays 6% against its own uncapped run.

Uncapped, Stanza and node-x12 tie at 13.4 s and 13.6 s. The memory ceiling is
the constraint that breaks streaming code in serverless and edge runtimes.

Full tables, fairness notes, and the feature matrix: [`COMPARISON.md`](COMPARISON.md).

## Method

- **Corpus**: 500.5 MB of synthetic 837P claims, 255,000 transactions, about
  1,963 bytes each, generated deterministically from a seed. No PHI, no
  customer data.
- **Process isolation**: each parser runs in a fresh process, sequentially,
  never in parallel.
- **Output**: discarded while parsing. The measurement is parse cost, not
  retention policy, because retaining 20.65M segment objects is a consumer
  decision and would change the memory picture.
- **Memory**: `peak_heap_mb` samples `process.memoryUsage().heapUsed` every
  25 ms. The capped run additionally enforces `--max-old-space-size=25`, which
  aborts the process if old-space allocation exceeds the bound.
- **Versions**: `node-x12@1.7.1`, `x12-parser@1.3.0`, Node v26.8.2, Core
  i7-10700K, Linux 7.2.5.

Three runs of the capped benchmark are in the README: 14.30 s, 14.38 s, and a
5 MB smoke run. The comparison uses the 14.2 s figure.

## Results

Capped at 25 MB old space:

| parser | mode | result | wall | items emitted | sampled peak heap |
| :-- | :-- | :-- | --: | --: | --: |
| Stanza | streaming, domain parsing | ok | **14.2 s** | 255,001 transactions | 22.2 MB |
| node-x12 | streaming, lax | ok | 20.3 s | 20,655,000 segments | 26.2 MB |
| x12-parser | streaming | ok | 39.2 s | 20,655,000 segments | 32.8 MB |
| node-x12 | streaming, strict | fails on valid input | — | — | — |

Uncapped, with V8 free to use memory:

| parser | wall | sampled peak heap |
| :-- | --: | --: |
| Stanza | 13.4 s | 94.7 MB |
| node-x12 | 13.6 s | 35.4 MB |
| x12-parser | 32.3 s | 32.9 MB |

## Reading the results

Uncapped, the two parsers tie: 13.4 s against 13.6 s. A raw speed claim over
node-x12 would not survive a re-run of this harness.

Under the cap, node-x12 goes from 13.6 s to 20.3 s (+49%), x12-parser from
32.3 s to 39.2 s (+21%), and Stanza from 13.4 s to 14.2 s (+6%). A hard ceiling
does not change the parsing work; it changes how much of that work can be
buffered, and a streaming design pays for itself there.

A sampled heap above 25 MB is not a breach. node-x12 samples 26.2 MB and
x12-parser 32.8 MB while both finish. `--max-old-space-size=25` bounds old
space; the sampled `heapUsed` includes the young generation and moves with GC
timing. Both libraries complete under the cap, slower. node-x12 in *strict*
mode fails on a valid file, not on memory.

Stanza emits 255,001 parsed transaction frames. The libraries emit 20,655,000
raw segment objects for the consumer to interpret, 81x more, and none of them
know what a claim is. The parser does more work per record and hands the
consumer less.

node-x12 strict mode fails on a valid file. Used as documented, it throws
`An EDI document must contain at least one functional group` on a well-formed
single-envelope file, because the stream path validates an interchange model it
never built. The comparison uses lax mode and publishes the reproduction
command.

## What this does not prove

- This is not a fastest-parser result: uncapped, the two leading libraries tie.
- The parsers do different work. Stanza maps 837P claims into typed frames with
  SNIP element checks; the libraries build generic segment trees. Stanza does
  more work per record, emits fewer objects, and holds the same or better speed.
- The corpus is synthetic and single-machine. It is reproducible, not
  independently replicated.
- The parser's own gap is in the record: it does not validate ST02/SE02
  consistency, and node-x12 strict mode is what surfaced that by rejecting the
  original corpus. It is tracked as `structure.st-se-control-mismatch`.

## Reproduce

With Nix there is nothing to install; the flake builds `node_modules` and
`dist/` from the lockfile.

```bash
# from anywhere, no checkout: ~5 MB under the cap
nix run github:StanzaAPI/benchmark-harness#smoke

# full run from a checkout
nix run .#generate -- --transactions 255000 --claims 5 --out data/claims.x12
nix run .#bench    -- data/claims.x12
nix run .#compare  -- --file data/claims.x12 --cap 25
```

Or `make bench`, which runs the three commands above in order. Without Nix:
`npm install && npm run build`, then `node --max-old-space-size=25
bin/run.mjs data/claims.x12`.

Throughput varies with CPU and Node version. Run it and publish where your
numbers land differently.

## Files

- [`COMPARISON.md`](COMPARISON.md) — full head-to-head, fairness notes, feature
  matrix, drawbacks.
- `bin/generate.mjs` — deterministic corpus generator.
- `bin/run.mjs` — the capped streaming run.
- `bin/compare.mjs` — runs all three parsers in fresh processes.
- `src/services/tokenizer.ts` — the zero-regex char-DFA tokenizer.
