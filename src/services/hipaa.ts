// =========================================================================
// Pure Functional HIPAA De-Identification & Rehydration Engine
// Architecture:
// - Strict Determinism: f(x) = y pure compute transformations
// - Branch Minimization: static frozen lookup tables (Record<string, ...>)
// - Flat Execution Paths: declarative rule pipelines (flatMap / filter / reduce)
// - Zero Unintended Side-Effects: preserves untouched EDI segments verbatim
// =========================================================================

import type {
  HipaaIdentifierType,
  DetectedEntity,
  HipaaRedactRequest,
  HipaaRedactResponseData,
  HipaaRehydrateRequest,
  HipaaRehydrateResponseData,
} from '../types/hipaa.js';
import { detectDelimiters } from './tokenizer.js';
import { validateNpiLuhn } from './snip.js';

/**
 * Fast deterministic arithmetic hash fold (f(str, salt) = int)
 */
function hashString(str: string, salt: string = ''): number {
  let hash = 5381;
  const combined = salt + str;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) + hash + combined.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Encrypts/seals a value with a secret key for stateless rehydration
 */
function sealValue(val: string, key: string): string {
  const bytes = new TextEncoder().encode(val);
  const keyBytes = new TextEncoder().encode(key);
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const k = keyBytes[i % keyBytes.length];
    out.push((bytes[i] ^ k).toString(16).padStart(2, '0'));
  }
  return out.join('');
}

/**
 * Decrypts a value sealed with sealValue
 */
function unsealValue(hex: string, key: string): string {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return hex;
  }
  const keyBytes = new TextEncoder().encode(key);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return new TextDecoder().decode(bytes);
}

function formatSurrogateToken(
  type: string,
  val: string,
  plainToken: string,
  secretKey?: string
): string {
  return secretKey ? `[${type}:ENC_${sealValue(val, secretKey)}]` : plainToken;
}

function formatEdiToken(val: string, plainToken: string, secretKey?: string): string {
  return secretKey ? `ENC_${sealValue(val, secretKey)}` : plainToken;
}

interface EntityCandidate {
  readonly type: HipaaIdentifierType;
  readonly originalValue: string;
  readonly start: number;
  readonly end: number;
  readonly surrogateToken: string;
}

interface TextRule {
  readonly type: HipaaIdentifierType;
  readonly pattern: RegExp;
  readonly makeToken: (matched: string, salt: string, secretKey?: string, execMatch?: RegExpExecArray) => string;
  readonly extractValue?: (execMatch: RegExpExecArray) => { value: string; startOffset: number };
  readonly filter?: (val: string, execMatch: RegExpExecArray) => boolean;
}

/**
 * Static frozen table of declarative entity detection rules.
 * Eliminates cascading if/else ladders and nested branch conditions.
 */
const TEXT_DETECTION_RULES: readonly TextRule[] = Object.freeze([
  // 1. Social Security Numbers (SSN)
  {
    type: 'SSN' as const,
    pattern: /\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)(\d{4})\b/g,
    makeToken: (val, _salt, secretKey, m) =>
      formatSurrogateToken('SSN', val, `[REDACTED_SSN:${m ? m[1] : val.slice(-4)}]`, secretKey),
  },
  // 2. National Provider Identifiers (NPI)
  {
    type: 'NPI' as const,
    pattern: /\b(?:NPI[:\s]+)?([1-9]\d{9})\b/gi,
    filter: (val, m) => m[0].toUpperCase().includes('NPI') || validateNpiLuhn(val),
    extractValue: (m) => ({ value: m[1], startOffset: m[0].indexOf(m[1]) }),
    makeToken: (val, _salt, secretKey) =>
      formatSurrogateToken('NPI', val, `[NPI:${val}]`, secretKey),
  },
  // 3. Clinical Dates (Gregorian MM/DD/YYYY or YYYY-MM-DD)
  {
    type: 'DATE' as const,
    pattern: /\b(?:(0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])[-/](19\d\d|20\d\d)|(19\d\d|20\d\d)[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01]))\b/g,
    makeToken: (val, _salt, secretKey, m) => {
      const year = m ? m[3] || m[4] : val.slice(0, 4);
      return formatSurrogateToken('DATE', val, `[YEAR:${year}]`, secretKey);
    },
  },
  // 4. Provider Names ("Dr. First Last", "Attending Physician: Dr. First Last, MD")
  {
    type: 'NAME' as const,
    pattern: /(?:Dr\.|Physician:?\s+Dr\.)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)(?:,\s*(?:MD|DO|NP|PA))?/g,
    extractValue: (m) => ({ value: m[1], startOffset: m[0].indexOf(m[1]) }),
    makeToken: (val, salt, secretKey) => {
      const hash = (hashString(val, salt) % 90 + 10).toString();
      return formatSurrogateToken('PROVIDER', val, `[PROVIDER:${hash}]`, secretKey);
    },
  },
  // 5. Patient Names ("Patient First Last")
  {
    type: 'NAME' as const,
    pattern: /Patient\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g,
    extractValue: (m) => ({ value: m[1], startOffset: m[0].indexOf(m[1]) }),
    makeToken: (val, salt, secretKey) => {
      const hash = (hashString(val, salt) % 9000 + 1000).toString();
      return formatSurrogateToken('PATIENT_ID', val, `[PATIENT_ID:STZ-${hash}]`, secretKey);
    },
  },
  // 6. Healthcare Facilities / Hospitals
  {
    type: 'GEOGRAPHY' as const,
    pattern: /\b(?:(?:St\.|Mount|Fort)\s+)?(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Hospital|Clinic|Medical Center|Healthcare))\b/g,
    makeToken: (val, salt, secretKey) => {
      const hash = (hashString(val, salt) % 90 + 1).toString().padStart(2, '0');
      return formatSurrogateToken('FACILITY', val, `[FACILITY:${hash}]`, secretKey);
    },
  },
  // 7. Emails
  {
    type: 'EMAIL' as const,
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    makeToken: (val, salt, secretKey) =>
      formatSurrogateToken('EMAIL', val, `[REDACTED_EMAIL:${hashString(val, salt) % 1000}]`, secretKey),
  },
  // 8. Phone Numbers
  {
    type: 'PHONE' as const,
    pattern: /\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    makeToken: (val, _salt, secretKey) =>
      formatSurrogateToken('PHONE', val, `[REDACTED_PHONE:${val.slice(-4)}]`, secretKey),
  },
  // 9. IPv4 Addresses
  {
    type: 'IP' as const,
    pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    makeToken: (val, _salt, secretKey) =>
      formatSurrogateToken('IP', val, '[REDACTED_IP]', secretKey),
  },
]);

/**
 * Scans text using the declarative rule pipeline without conditional cascades
 */
function findEntitiesInText(
  text: string,
  allowedTypes?: ReadonlySet<HipaaIdentifierType>,
  salt: string = '',
  secretKey?: string
): readonly EntityCandidate[] {
  const activeRules = allowedTypes
    ? TEXT_DETECTION_RULES.filter((rule) => allowedTypes.has(rule.type))
    : TEXT_DETECTION_RULES;

  const rawCandidates: EntityCandidate[] = activeRules.flatMap((rule) => {
    const candidates: EntityCandidate[] = [];
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const extracted = rule.extractValue ? rule.extractValue(match) : { value: match[0], startOffset: 0 };
      const val = extracted.value;

      if (rule.filter && !rule.filter(val, match)) {
        continue;
      }

      const start = match.index + extracted.startOffset;
      const end = start + val.length;
      const surrogateToken = rule.makeToken(val, salt, secretKey, match);

      candidates.push({
        type: rule.type,
        originalValue: val,
        start,
        end,
        surrogateToken,
      });
    }

    return candidates;
  });

  // Pure sort and non-overlapping interval filter
  return rawCandidates
    .sort((a, b) => a.start - b.start)
    .reduce<readonly EntityCandidate[]>((acc, curr) => {
      const last = acc[acc.length - 1];
      return !last || curr.start >= last.end ? [...acc, curr] : acc;
    }, []);
}

interface SegmentScrubResult {
  readonly scrubbed: string;
  readonly entities: readonly DetectedEntity[];
  readonly tokenMap: Readonly<Record<string, string>>;
}

type SegmentScrubberFn = (
  rawBody: string,
  elementDelim: string,
  salt: string,
  secretKey?: string
) => SegmentScrubResult;

// Segment Scrubber Helper: Modifies specific indices of delimited elements
function scrubDelimitedElements(
  rawBody: string,
  elementDelim: string,
  transformIndices: (elements: string[]) => {
    entities: DetectedEntity[];
    tokenMap: Record<string, string>;
  }
): SegmentScrubResult {
  const elements = rawBody.split(elementDelim);
  const { entities, tokenMap } = transformIndices(elements);
  return {
    scrubbed: elements.join(elementDelim),
    entities,
    tokenMap,
  };
}

/**
 * Static frozen lookup table of segment scrubber functions ($O(1)$ dispatch).
 * Completely replaces sprawling if/else segment parsing ladders.
 */
const SENSITIVE_PERSON_ENTITIES: ReadonlySet<string> = new Set(['IL', 'QC', '74']);
const SENSITIVE_MEMBER_QUALS: ReadonlySet<string> = new Set(['MI', 'II', 'SY']);
const PER_CONTACT_MAP: Readonly<Record<string, HipaaIdentifierType>> = Object.freeze({
  EM: 'EMAIL',
  FX: 'FAX',
  TE: 'PHONE',
});
const SENSITIVE_REF_QUALS: ReadonlySet<string> = new Set(['SY', 'EA', 'EJ']);

/**
 * Static frozen lookup table of segment scrubber functions ($O(1)$ dispatch).
 * Completely replaces sprawling if/else segment parsing ladders.
 */
const SEGMENT_SCRUBBERS: Readonly<Record<string, SegmentScrubberFn>> = Object.freeze({
  NM1: (raw, delim, salt, secretKey) =>
    scrubDelimitedElements(raw, delim, (elements) => {
      const entities: DetectedEntity[] = [];
      const tokenMap: Record<string, string> = {};
      const entityId = elements[1];
      const isPerson = elements[2] === '1';

      if (isPerson && SENSITIVE_PERSON_ENTITIES.has(entityId)) {
        if (elements[3]) {
          const orig = elements[3];
          const token = formatEdiToken(orig, `STZ_NAME_${hashString(orig, salt) % 1000}`, secretKey);
          tokenMap[token] = orig;
          elements[3] = token;
          entities.push({ type: 'NAME', surrogateToken: token, originalValue: orig });
        }
        if (elements[4]) {
          const orig = elements[4];
          const token = formatEdiToken(orig, `STZ_PAT_${hashString(orig, salt) % 1000}`, secretKey);
          tokenMap[token] = orig;
          elements[4] = token;
          entities.push({ type: 'NAME', surrogateToken: token, originalValue: orig });
        }
      }

      if (elements[9] && SENSITIVE_MEMBER_QUALS.has(elements[8])) {
        const orig = elements[9];
        const token = formatEdiToken(orig, `STZ_MBR_${hashString(orig, salt) % 10000000}`, secretKey);
        tokenMap[token] = orig;
        elements[9] = token;
        entities.push({ type: 'MEMBER_ID', surrogateToken: token, originalValue: orig });
      }

      return { entities, tokenMap };
    }),

  DMG: (raw, delim, salt, secretKey) =>
    scrubDelimitedElements(raw, delim, (elements) => {
      const entities: DetectedEntity[] = [];
      const tokenMap: Record<string, string> = {};
      if (elements[2] && elements[2].length === 8) {
        const orig = elements[2];
        const year = orig.slice(0, 4);
        const token = formatEdiToken(orig, `STZ_DOB_${year}0101`, secretKey);
        tokenMap[token] = orig;
        elements[2] = token;
        entities.push({ type: 'DATE', surrogateToken: token, originalValue: orig });
      }
      return { entities, tokenMap };
    }),

  N3: (raw, delim, salt, secretKey) =>
    scrubDelimitedElements(raw, delim, (elements) => {
      const entities: DetectedEntity[] = [];
      const tokenMap: Record<string, string> = {};
      if (elements[1]) {
        const orig = elements[1];
        const token = formatEdiToken(orig, `STZ_ADDR_${hashString(orig, salt) % 1000}`, secretKey);
        tokenMap[token] = orig;
        elements[1] = token;
        entities.push({ type: 'GEOGRAPHY', surrogateToken: token, originalValue: orig });
      }
      return { entities, tokenMap };
    }),

  N4: (raw, delim, salt, secretKey) =>
    scrubDelimitedElements(raw, delim, (elements) => {
      const entities: DetectedEntity[] = [];
      const tokenMap: Record<string, string> = {};
      if (elements[1]) {
        const orig = elements[1];
        const token = formatEdiToken(orig, `STZ_CITY_${hashString(orig, salt) % 100}`, secretKey);
        tokenMap[token] = orig;
        elements[1] = token;
        entities.push({ type: 'GEOGRAPHY', surrogateToken: token, originalValue: orig });
      }
      if (elements[3]) {
        const orig = elements[3];
        const token = formatEdiToken(orig, `STZ_ZIP_${hashString(orig, salt) % 1000}`, secretKey);
        tokenMap[token] = orig;
        elements[3] = token;
        entities.push({ type: 'GEOGRAPHY', surrogateToken: token, originalValue: orig });
      }
      return { entities, tokenMap };
    }),

  PER: (raw, delim, _salt, secretKey) =>
    scrubDelimitedElements(raw, delim, (elements) => {
      const entities: DetectedEntity[] = [];
      const tokenMap: Record<string, string> = {};
      for (let i = 3; i < elements.length; i += 2) {
        const type = PER_CONTACT_MAP[elements[i]];
        const val = elements[i + 1];
        if (val && type) {
          const token = formatEdiToken(val, `STZ_TEL_${val.slice(-4)}`, secretKey);
          tokenMap[token] = val;
          elements[i + 1] = token;
          entities.push({ type, surrogateToken: token, originalValue: val });
        }
      }
      return { entities, tokenMap };
    }),

  REF: (raw, delim, salt, secretKey) =>
    scrubDelimitedElements(raw, delim, (elements) => {
      const entities: DetectedEntity[] = [];
      const tokenMap: Record<string, string> = {};
      const qual = elements[1];
      const val = elements[2];
      if (val && SENSITIVE_REF_QUALS.has(qual)) {
        const token = formatEdiToken(val, `STZ_REF_${hashString(val, salt) % 10000}`, secretKey);
        tokenMap[token] = val;
        elements[2] = token;
        entities.push({ type: 'SSN', surrogateToken: token, originalValue: val });
      }
      return { entities, tokenMap };
    }),
});

/**
 * Escapes regex special characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure transformation pipeline for structured ANSI X12 EDI text.
 * Preserves untouched segments 100% byte-for-byte, including fixed-width spacing and delimiters.
 */
function scrubX12Edi(
  rawEdi: string,
  salt: string = '',
  secretKey?: string
): { readonly safeEdi: string; readonly entities: readonly DetectedEntity[]; readonly tokenMap: Readonly<Record<string, string>> } {
  const delim = detectDelimiters(rawEdi);
  const segRegex = new RegExp(`([^${escapeRegex(delim.segment)}]+)(${escapeRegex(delim.segment)}[\\r\\n]*)`, 'g');

  const entities: DetectedEntity[] = [];
  const tokenMap: Record<string, string> = {};
  let safeEdi = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = segRegex.exec(rawEdi)) !== null) {
    const rawBody = match[1];
    const tail = match[2];
    lastIndex = segRegex.lastIndex;

    const delimIdx = rawBody.indexOf(delim.element);
    const tag = delimIdx === -1 ? rawBody.trim() : rawBody.slice(0, delimIdx).trim();

    const scrubber = SEGMENT_SCRUBBERS[tag];
    if (scrubber) {
      const scrubbed = scrubber(rawBody, delim.element, salt, secretKey);
      safeEdi += scrubbed.scrubbed + tail;
      entities.push(...scrubbed.entities);
      Object.assign(tokenMap, scrubbed.tokenMap);
    } else {
      // Untouched segment: preserved exactly as-is
      safeEdi += rawBody + tail;
    }
  }

  safeEdi += rawEdi.slice(lastIndex);

  return { safeEdi, entities, tokenMap };
}

/**
 * Pure Functional HIPAA De-Identification Engine (f(x) = y).
 * Runnable LOCALLY in client/SDK environments without network subrequests.
 */
export function redactHipaa(req: HipaaRedactRequest): HipaaRedactResponseData {
  const salt = req.surrogateSalt ?? 'stz_safe';
  const secretKey = req.secretKey;
  const tokenize = req.tokenizeForLlm ?? true;
  const allowedSet = req.safeHarborIdentifiers ? new Set(req.safeHarborIdentifiers) : undefined;

  let safeText: string | undefined;
  let safeEdi: string | undefined;
  const detectedEntities: DetectedEntity[] = [];
  const tokenMap: Record<string, string> = {};

  // 1. Process Unstructured Text Pipeline
  if (req.unstructuredText !== undefined) {
    const text = req.unstructuredText;
    const candidates = findEntitiesInText(text, allowedSet, salt, secretKey);

    let resultText = '';
    let curr = 0;

    for (const c of candidates) {
      resultText += text.slice(curr, c.start);
      const replacement = tokenize ? c.surrogateToken : '[REDACTED]';
      resultText += replacement;
      curr = c.end;

      if (tokenize) {
        tokenMap[c.surrogateToken] = c.originalValue;
      }
      detectedEntities.push({
        type: c.type,
        surrogateToken: replacement,
        originalValue: c.originalValue,
        start: c.start,
        end: c.end,
      });
    }
    resultText += text.slice(curr);
    safeText = resultText;
  }

  // 2. Process Structured ANSI X12 EDI Pipeline
  if (req.rawEdi !== undefined && req.rawEdi.trim().length > 0) {
    const ediResult = scrubX12Edi(req.rawEdi, salt, secretKey);
    safeEdi = ediResult.safeEdi;
    detectedEntities.push(...ediResult.entities);
    Object.assign(tokenMap, ediResult.tokenMap);
  }

  return {
    safeText,
    safeEdi,
    phiIdentifiersScrubbed: detectedEntities.length,
    detectedEntities,
    tokenMap: Object.keys(tokenMap).length > 0 ? tokenMap : undefined,
    rehydrationMode: secretKey ? 'encrypted_token' : tokenize ? 'token_map' : 'masked',
  };
}

/**
 * Pure Functional HIPAA Rehydration Engine.
 * Allows rehydrating surrogate tokens anywhere (in secure enclave, destination VPC, etc.).
 */
export function rehydrateHipaa(req: HipaaRehydrateRequest): HipaaRehydrateResponseData {
  let text = req.redactedText;
  let edi = req.redactedEdi;
  let tokensReplaced = 0;

  // Pipeline Stage 1: Rehydration via Token Map
  if (req.tokenMap) {
    const map = req.tokenMap;
    // Replace longest tokens first to avoid partial prefix collisions
    const sortedTokens = Object.keys(map).sort((a, b) => b.length - a.length);

    for (const token of sortedTokens) {
      const orig = map[token];
      if (text && text.includes(token)) {
        const count = text.split(token).length - 1;
        text = text.replaceAll(token, orig);
        tokensReplaced += count;
      }
      if (edi && edi.includes(token)) {
        const count = edi.split(token).length - 1;
        edi = edi.replaceAll(token, orig);
        tokensReplaced += count;
      }
    }
  }

  // Pipeline Stage 2: Rehydration via Stateless Sealed Encryption
  if (req.secretKey) {
    const key = req.secretKey;
    const encRegex = /\[[A-Z_]+:ENC_([^\]]+)\]/g;
    if (text) {
      text = text.replace(encRegex, (_match, hex) => {
        tokensReplaced++;
        return unsealValue(hex, key);
      });
    }

    const ediEncRegex = /\bENC_([A-Za-z0-9_!]+)\b/g;
    if (edi) {
      edi = edi.replace(ediEncRegex, (_match, hex) => {
        tokensReplaced++;
        return unsealValue(hex, key);
      });
    }
  }

  return {
    rehydratedText: text,
    rehydratedEdi: edi,
    tokensReplaced,
  };
}
