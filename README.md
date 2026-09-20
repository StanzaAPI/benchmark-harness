# Stanza Streaming Parser Benchmark

Reproducible benchmark for the zero-regex X12 streaming parser that powers
[Stanza API](https://stanzaapi.com). It measures throughput and V8 memory
behavior on large synthetic healthcare claim batches.

All data is generated locally and is entirely synthetic. No protected health
information (PHI) or customer data is used, stored, or required.

## What is measured

- **Wall time** to stream a single X12 file through `iterateX12StreamFrames`,
  the NDJSON-emitting streaming path used in production.
- **Peak sampled V8 heap** (`process.memoryUsage().heapUsed`, sampled every
  25ms) and whether the run completes under a hard
  `--max-old-space-size=25` old-space cap.
- **Record throughput**: one record is one X12 transaction (`ST`..`SE` block),
  parsed into a frame and discarded. The benchmark measures parsing, not
  retention.

## Reproduce

Requires Node >= 23.

```bash
npm install
npm run build

# ~500 MB, 255k transactions, ~2 KB per record
node bin/generate.mjs --transactions 255000 --claims 5 --out data/claims.x12

# Hard 25 MB old-space cap
node --max-old-space-size=25 bin/run.mjs data/claims.x12
```

Quick check on ~5 MB instead:

```bash
npm run smoke
```

## Reference results

Hardware: Intel Core i7-10700K @ 3.80GHz, 31 GiB RAM, Linux 7.2.5, Node v26.8.2.
Synthetic file: 500.5 MB (477.3 MiB), 255,000 transactions, 1,963 bytes/record.

| Run | Wall time | Records/s | MiB/s | Peak `heapUsed` | Under 25 MB cap |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 14.30 s | 17,837 | 33.4 | 31.6 MB | yes |
| 2 | 14.38 s | 17,729 | 32.8 | 20.7 MB | yes |
| smoke (5 MB) | 0.12 s | 16,468 | 26.2 | 7.9 MB | yes |

Notes on the memory column:

- The hard constraint is the `--max-old-space-size=25` cap: a run that exceeds
  it aborts. Both full runs completed.
- Sampled `heapUsed` includes the young generation and is GC-timing dependent,
  which is why run 1 shows 31.6 MB while still finishing under the cap.
- `rss` is around 140 MB, dominated by the stream buffers and Node baseline,
  not by parser allocations.

Throughput varies with CPU and Node version. Run the commands above to measure
your own machine.

## Design notes

- The parser is copied verbatim from the production implementation:
  `tokenizer.ts`, `parser837/835/271.ts`, `stream.ts`, plus their types. The
  only change is that the HTTP/routes layer is omitted.
- `DEFAULT_MAX_STREAM_RECORDS` is 50,000. Batches larger than that require
  passing `maxRecords` explicitly; this harness passes a high ceiling.
- The tokenizer contains no regular expressions (see `tokenizer.ts`); segment
  and element splitting is done with character indexing only.

## License

MIT
