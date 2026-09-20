import { Delimiters, ParsedSegment } from '../types/index.js';

export function optStr(val: string | undefined): string | undefined {
  return val && val.length > 0 ? val : undefined;
}

export function optNum(val: number | undefined): number | undefined {
  return typeof val === 'number' && !Number.isNaN(val) ? val : undefined;
}

export function optObj<T extends object>(val: T): T | undefined {
  return Object.keys(val).length > 0 ? val : undefined;
}

/**
 * Pure zero-regex number parser.
 * Extracts numeric digits, optional negative sign, and decimal point via charCode.
 */
export function parseEdiNumber(val: string): number {
  if (!val) return 0;
  let clean = '';
  const len = val.length;
  for (let i = 0; i < len; i++) {
    const code = val.charCodeAt(i);
    // '0'-'9' (48-57), '-' (45), '.' (46)
    if ((code >= 48 && code <= 57) || code === 45 || code === 46) {
      clean += val[i];
    }
  }
  const n = parseFloat(clean);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Pure zero-regex composite element splitter.
 * Linear O(N) single-pass scan splitting on component delimiter or standard `:` / `^`.
 */
export function splitComposite(composite: string, componentDelim: string = ':'): string[] {
  if (!composite) return [];
  const parts: string[] = [];
  let start = 0;
  const len = composite.length;
  for (let i = 0; i < len; i++) {
    const c = composite[i];
    if (c === componentDelim || c === ':' || c === '^') {
      parts.push(composite.substring(start, i));
      start = i + 1;
    }
  }
  parts.push(composite.substring(start));
  return parts;
}

/**
 * Detects delimiters from a raw X12 EDI payload starting with the ISA header.
 * 100% regex-free: handles standard 106-character ISA headers, UTF-8 BOM, and variable-length field anomalies.
 */
export function detectDelimiters(edi: string): Delimiters {
  if (!edi || edi.length < 100) {
    throw new Error('Invalid EDI payload: Must begin with a valid 106-character ISA segment.');
  }

  // Strip UTF-8 BOM without regex
  let offset = edi.charCodeAt(0) === 0xFEFF ? 1 : 0;
  while (offset < edi.length && (edi.charCodeAt(offset) === 32 || edi.charCodeAt(offset) === 10 || edi.charCodeAt(offset) === 13)) {
    offset++;
  }

  const clean = offset > 0 ? edi.slice(offset) : edi;
  if (!clean.startsWith('ISA') || clean.length < 100) {
    throw new Error('Invalid EDI payload: Must begin with a valid 106-character ISA segment.');
  }

  const element = clean[3];

  // Dynamically find all 16 element separator positions in the ISA header
  const separatorIndices: number[] = [];
  const cleanLen = clean.length;
  for (let i = 3; i < cleanLen; i++) {
    if (clean[i] === element) {
      separatorIndices.push(i);
      if (separatorIndices.length === 16) {
        break;
      }
    }
  }

  if (separatorIndices.length < 16) {
    throw new Error('Invalid EDI payload: Must begin with a valid 106-character ISA segment.');
  }

  // ISA11 is Repetition Separator (standard in 5010)
  const repSeparatorIdx = separatorIndices[10];
  const repetitionChar = clean[repSeparatorIdx + 1];
  const nextSeparatorChar = clean[separatorIndices[11]];
  const repetition =
    repetitionChar !== element && repetitionChar !== 'U' && repetitionChar !== nextSeparatorChar
      ? repetitionChar
      : undefined;

  // ISA16 is Component Element Separator (1 character following 16th element separator)
  const compIdx = separatorIndices[15] + 1;
  const component = clean[compIdx];
  let segment = clean[compIdx + 1];

  // If next char is newline or CR, normalize segment terminator
  if (segment === '\r') {
    segment = '\n';
  }

  return {
    element,
    component,
    repetition,
    segment,
  };
}

/**
 * Splits raw EDI text into structured segments using linear O(N) scanning.
 * Zero-regex, pure single-loop character DFA.
 */
export function tokenizeEdi(edi: string, delimiters?: Delimiters): { delimiters: Delimiters; segments: ParsedSegment[] } {
  const activeDelimiters = delimiters || detectDelimiters(edi);
  const { element, segment } = activeDelimiters;

  const len = edi.length;
  const segments: ParsedSegment[] = [];
  let start = 0;
  let segIndex = 0;

  for (let i = 0; i < len; i++) {
    if (edi[i] === segment) {
      if (i > start) {
        const raw = edi.slice(start, i).trim();
        if (raw.length > 0) {
          const elements = raw.split(element).map((el) => el.trim());
          segments.push({
            tag: elements[0],
            elements,
            raw,
            index: segIndex++,
          });
        }
      }
      start = i + 1;
    }
  }

  // Handle trailing segment if non-empty
  if (start < len) {
    const raw = edi.slice(start).trim();
    if (raw.length > 0) {
      const elements = raw.split(element).map((el) => el.trim());
      segments.push({
        tag: elements[0],
        elements,
        raw,
        index: segIndex++,
      });
    }
  }

  return {
    delimiters: activeDelimiters,
    segments,
  };
}

/**
 * Streams/yields parsed EDI segments one by one via a generator.
 * Memory complexity is O(1) relative to total EDI file size, making it suitable
 * for streaming multi-hundred-megabyte files without heap exhaustion.
 */
export function* iterateEdiSegments(edi: string, delimiters?: Delimiters): Generator<ParsedSegment> {
  const activeDelimiters = delimiters || detectDelimiters(edi);
  const { element, segment } = activeDelimiters;

  const len = edi.length;
  let start = 0;
  let segIndex = 0;

  for (let i = 0; i < len; i++) {
    if (edi[i] === segment) {
      if (i > start) {
        const raw = edi.slice(start, i).trim();
        if (raw.length > 0) {
          const elements = raw.split(element).map((el) => el.trim());
          yield {
            tag: elements[0],
            elements,
            raw,
            index: segIndex++,
          };
        }
      }
      start = i + 1;
    }
  }

  if (start < len) {
    const raw = edi.slice(start).trim();
    if (raw.length > 0) {
      const elements = raw.split(element).map((el) => el.trim());
      yield {
        tag: elements[0],
        elements,
        raw,
        index: segIndex++,
      };
    }
  }
}

/**
 * Helper to safely extract an element from a segment (1-indexed matching EDI standards).
 */
export function getElement(segment: ParsedSegment | undefined, elementIndex: number): string {
  if (!segment || !segment.elements || elementIndex >= segment.elements.length) {
    return '';
  }
  return segment.elements[elementIndex];
}

