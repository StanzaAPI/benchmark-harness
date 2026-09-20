import type { Delimiters, ParsedSegment } from '../types/index.js';
import { detectDelimiters, getElement } from './tokenizer.js';
import { parse837Transaction } from './parser837.js';
import { parse835Transaction } from './parser835.js';
import { parse271Transaction } from './parser271.js';

export interface X12StreamOptions {
  failFast?: boolean;
  maxRecords?: number;
}

export interface StreamTransactionFrame {
  type: 'transaction';
  valid: boolean;
  transactionType: string;
  controlNumber: string;
  data: unknown;
}

export interface StreamErrorFrame {
  type: 'error';
  valid?: boolean;
  code: string;
  transactionType?: string;
  controlNumber?: string;
  message: string;
}

export interface StreamSummaryFrame {
  type: 'summary';
  records_parsed: number;
  records_valid: number;
  records_invalid: number;
  duration_ms: number;
}

export type StreamFrame = StreamTransactionFrame | StreamErrorFrame | StreamSummaryFrame;

export const DEFAULT_MAX_STREAM_RECORDS = 50_000;

interface ParsedTransactionBlock {
  valid: boolean;
  transactionType: string;
  controlNumber: string;
  data?: unknown;
  error?: string;
}

function parseTransactionBlock(segments: ParsedSegment[]): ParsedTransactionBlock {
  const transactionType = getElement(segments[0], 1);
  const controlNumber = getElement(segments[0], 2);

  try {
    if (segments.length < 3) {
      throw new Error('Truncated transaction set: Missing required loop segments');
    }
    let parsedData: unknown;
    if (transactionType === '837') {
      parsedData = parse837Transaction(segments);
    } else if (transactionType === '835') {
      parsedData = parse835Transaction(segments);
    } else if (transactionType === '270' || transactionType === '271') {
      parsedData = parse271Transaction(segments);
    } else {
      parsedData = {
        transactionType,
        controlNumber,
        segmentCount: segments.length,
        segments,
      };
    }
    return { valid: true, transactionType, controlNumber, data: parsedData };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return { valid: false, transactionType, controlNumber, error };
  }
}

/**
 * Async generator that reads chunks of Uint8Array from a ReadableStream,
 * tokenizes X12 transactions on the fly without holding the entire document in memory,
 * and yields Newline Delimited JSON (NDJSON) string frames.
 */
export async function* iterateX12StreamFrames(
  inputStream: ReadableStream<Uint8Array>,
  options: X12StreamOptions = {}
): AsyncGenerator<string> {
  const startTime = performance.now();
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_STREAM_RECORDS;
  const failFast = options.failFast ?? false;

  const reader = inputStream.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let delimiters: Delimiters | null = null;
  let segIndex = 0;
  let currentTransactionSegments: ParsedSegment[] = [];

  let recordsParsed = 0;
  let recordsValid = 0;
  let recordsInvalid = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (delimiters && buffer.trim().length > 0 && !buffer.endsWith(delimiters.segment)) {
          buffer += delimiters.segment;
        }
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      // Try to detect delimiters once we have at least 106 characters
      if (!delimiters && buffer.length >= 106) {
        try {
          delimiters = detectDelimiters(buffer);
        } catch (_err) {
          if (buffer.length > 512 || done) {
            yield JSON.stringify({
              type: 'error',
              code: 'INVALID_EDI',
              message: 'Invalid EDI payload: Failed to detect valid 106-character ISA segment.',
            } satisfies StreamErrorFrame) + '\n';
            return;
          }
        }
      }

      if (delimiters) {
        let segEnd = buffer.indexOf(delimiters.segment);
        while (segEnd !== -1) {
          const raw = buffer.slice(0, segEnd).trim();
          buffer = buffer.slice(segEnd + 1);

          if (raw.length > 0) {
            const elements = raw.split(delimiters.element).map((el) => el.trim());
            const seg: ParsedSegment = {
              tag: elements[0],
              elements,
              raw,
              index: segIndex++,
            };

            if (seg.tag === 'ST') {
              currentTransactionSegments = [seg];
            } else if (currentTransactionSegments.length > 0) {
              currentTransactionSegments.push(seg);
              if (seg.tag === 'SE') {
                recordsParsed++;
                const result = parseTransactionBlock(currentTransactionSegments);

                if (result.valid) {
                  recordsValid++;
                  yield JSON.stringify({
                    type: 'transaction',
                    valid: true,
                    transactionType: result.transactionType,
                    controlNumber: result.controlNumber,
                    data: result.data,
                  } satisfies StreamTransactionFrame) + '\n';
                } else {
                  recordsInvalid++;
                  yield JSON.stringify({
                    type: 'error',
                    valid: false,
                    code: 'INVALID_RECORD',
                    transactionType: result.transactionType,
                    controlNumber: result.controlNumber,
                    message: result.error!,
                  } satisfies StreamErrorFrame) + '\n';

                  if (failFast) {
                    return;
                  }
                }

                currentTransactionSegments = [];

                if (recordsParsed >= maxRecords) {
                  yield JSON.stringify({
                    type: 'error',
                    code: 'STREAM_BATCH_CEILING',
                    message: `Single stream batch ceiling reached (${maxRecords} records). Please segment larger files.`,
                  } satisfies StreamErrorFrame) + '\n';
                  return;
                }
              }
            }
          }

          segEnd = buffer.indexOf(delimiters.segment);
        }
      }

      if (done) {
        break;
      }
    }

    if (currentTransactionSegments.length > 0) {
      recordsInvalid++;
      yield JSON.stringify({
        type: 'error',
        valid: false,
        code: 'UNTERMINATED_TRANSACTION',
        message: 'Stream ended before matching SE segment was encountered.',
      } satisfies StreamErrorFrame) + '\n';
    }

    if (!delimiters && recordsParsed === 0) {
      yield JSON.stringify({
        type: 'error',
        code: 'INVALID_EDI',
        message: 'Invalid EDI payload: Stream ended without valid ISA header.',
      } satisfies StreamErrorFrame) + '\n';
      return;
    }
  } finally {
    reader.releaseLock();
  }

  const duration_ms = Math.max(0, Math.round((performance.now() - startTime) * 100) / 100);
  yield JSON.stringify({
    type: 'summary',
    records_parsed: recordsParsed,
    records_valid: recordsValid,
    records_invalid: recordsInvalid,
    duration_ms,
  } satisfies StreamSummaryFrame) + '\n';
}

/**
 * Creates a ReadableStream<Uint8Array> emitting NDJSON from an incoming X12 byte stream.
 */
export function createX12NdjsonStream(
  inputStream: ReadableStream<Uint8Array>,
  options: X12StreamOptions = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const generator = iterateX12StreamFrames(inputStream, options);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await generator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(encoder.encode(value));
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
