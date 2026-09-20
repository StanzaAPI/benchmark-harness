import type {
  SnipLevel,
  SnipIssue,
  SnipLevelSummary,
  SnipValidationResult,
} from '../types/snip.js';
import { tokenizeEdi, getElement } from './tokenizer.js';
import type { ParsedSegment } from '../types/index.js';



/**
 * Validates CMS Modulo-10 Luhn Check Digit for 10-digit NPIs
 */
export function validateNpiLuhn(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  // CMS standard: prefix with 80840 to form 15 digits
  const full = '80840' + npi;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let digit = full.charCodeAt(i) - 48; // ASCII '0' is 48
    // Odd positions from right (index 0, 2, 4... in 15-char string) are multiplied by 1
    // Even positions from right (index 1, 3, 5... in 15-char string) are multiplied by 2
    if ((14 - i) % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Validates Gregorian date in YYYYMMDD format
 */
function isValidDate(dateStr: string): boolean {
  if (!/^\d{8}$/.test(dateStr)) return false;
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(4, 6), 10);
  const day = parseInt(dateStr.slice(6, 8), 10);

  if (year < 1850 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  // Days in month check
  const daysInMonth = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

/**
 * Validates ICD-10-CM format: 3 to 7 alphanumeric chars, e.g. M545, I10, E11.9
 */
function isValidIcd10(code: string): boolean {
  return /^[A-TV-Z][0-9][0-9A-B](\.?[0-9A-TV-Z]{1,4})?$/i.test(code.trim());
}

/**
 * Validates CPT (5 digits / alphanumeric) or HCPCS (letter + 4 digits) format
 */
function isValidProcedureCode(code: string): boolean {
  const clean = code.trim();
  // CPT: 5 digits or 4 digits + letter (e.g. 99214, 00100, 1234F)
  // HCPCS: 1 letter + 4 digits (e.g. A0428, J0129)
  return /^[0-9]{4}[0-9A-Z]$/i.test(clean) || /^[A-V][0-9]{4}$/i.test(clean);
}

/**
 * Validates Healthcare Provider Taxonomy code: 10 alphanumeric ending in X
 */
function isValidTaxonomyCode(code: string): boolean {
  return /^[0-9A-Z]{9}X$/i.test(code.trim());
}


/**
 * Comprehensive WEDI SNIP Level 1-4 Automated Compliance Validator
 */
export function validateSnip(
  rawEdi: string,
  maxLevel: SnipLevel = 4
): SnipValidationResult {
  const level1Errors: SnipIssue[] = [];
  const level2Errors: SnipIssue[] = [];
  const level3Errors: SnipIssue[] = [];
  const level4Errors: SnipIssue[] = [];

  // =========================================================================
  // SNIP Level 1: EDI Syntax Integrity & Envelopes
  // =========================================================================
  let delimiters;
  let segments: ParsedSegment[] = [];

  try {
    const tokenized = tokenizeEdi(rawEdi);
    delimiters = tokenized.delimiters;
    segments = tokenized.segments;
  } catch (err: unknown) {

    const msg = err instanceof Error ? err.message : String(err);
    level1Errors.push({
      level: 1,
      code: 'SNIP1_SYNTAX_ERROR',
      message: `Critical EDI syntax error: ${msg}`,
    });
    return buildResult(1, maxLevel, level1Errors, level2Errors, level3Errors, level4Errors);
  }

  const isaSegments = segments.filter((s) => s.tag === 'ISA');
  const ieaSegments = segments.filter((s) => s.tag === 'IEA');
  const gsSegments = segments.filter((s) => s.tag === 'GS');
  const geSegments = segments.filter((s) => s.tag === 'GE');
  const stSegments = segments.filter((s) => s.tag === 'ST');
  const seSegments = segments.filter((s) => s.tag === 'SE');

  if (ieaSegments.length === 0) {
    level1Errors.push({ level: 1, code: 'SNIP1_MISSING_IEA', message: 'Missing IEA Interchange Control Trailer' });
  }
  if (gsSegments.length === 0) {
    level1Errors.push({ level: 1, code: 'SNIP1_MISSING_GS', message: 'Missing GS Functional Group Header' });
  }
  if (geSegments.length === 0) {
    level1Errors.push({ level: 1, code: 'SNIP1_MISSING_GE', message: 'Missing GE Functional Group Trailer' });
  }
  if (stSegments.length === 0) {
    level1Errors.push({ level: 1, code: 'SNIP1_MISSING_ST', message: 'Missing ST Transaction Set Header' });
  }
  if (seSegments.length === 0) {
    level1Errors.push({ level: 1, code: 'SNIP1_MISSING_SE', message: 'Missing SE Transaction Set Trailer' });
  }

  // Envelope control number checks
  if (isaSegments.length > 0 && ieaSegments.length > 0) {
    const isaCtrl = getElement(isaSegments[0], 13)?.trim();
    const ieaCtrl = getElement(ieaSegments[0], 2)?.trim();
    if (isaCtrl && ieaCtrl && isaCtrl !== ieaCtrl) {
      level1Errors.push({
        level: 1,
        code: 'SNIP1_ISA_IEA_CONTROL_MISMATCH',
        message: `ISA control number (${isaCtrl}) does not match IEA control number (${ieaCtrl})`,
        segment: 'IEA',
        elementPosition: 2,
      });
    }

    const groupCount = parseInt(getElement(ieaSegments[0], 1) || '0', 10);
    if (groupCount !== gsSegments.length) {
      level1Errors.push({
        level: 1,
        code: 'SNIP1_IEA_GROUP_COUNT_MISMATCH',
        message: `IEA01 group count (${groupCount}) does not match actual GS group count (${gsSegments.length})`,
        segment: 'IEA',
        elementPosition: 1,
      });
    }
  }

  // GS / GE control numbers
  for (let i = 0; i < Math.min(gsSegments.length, geSegments.length); i++) {
    const gsCtrl = getElement(gsSegments[i], 6)?.trim();
    const geCtrl = getElement(geSegments[i], 2)?.trim();
    if (gsCtrl && geCtrl && gsCtrl !== geCtrl) {
      level1Errors.push({
        level: 1,
        code: 'SNIP1_GS_GE_CONTROL_MISMATCH',
        message: `GS control number (${gsCtrl}) does not match GE control number (${geCtrl})`,
        segment: 'GE',
        elementPosition: 2,
      });
    }

    const txCount = parseInt(getElement(geSegments[i], 1) || '0', 10);
    if (txCount !== stSegments.length) {
      level1Errors.push({
        level: 1,
        code: 'SNIP1_GE_TX_COUNT_MISMATCH',
        message: `GE01 transaction count (${txCount}) does not match actual ST count (${stSegments.length})`,
        segment: 'GE',
        elementPosition: 1,
      });
    }
  }

  // ST / SE segment counts and control numbers
  for (let i = 0; i < Math.min(stSegments.length, seSegments.length); i++) {
    const stCtrl = getElement(stSegments[i], 2)?.trim();
    const seCtrl = getElement(seSegments[i], 2)?.trim();
    if (stCtrl && seCtrl && stCtrl !== seCtrl) {
      level1Errors.push({
        level: 1,
        code: 'SNIP1_ST_SE_CONTROL_MISMATCH',
        message: `ST control number (${stCtrl}) does not match SE control number (${seCtrl})`,
        segment: 'SE',
        elementPosition: 2,
      });
    }

    const stIdx = stSegments[i].index;
    const seIdx = seSegments[i].index;
    const actualCount = seIdx - stIdx + 1;
    const claimedCount = parseInt(getElement(seSegments[i], 1) || '0', 10);
    if (claimedCount !== actualCount) {
      level1Errors.push({
        level: 1,
        code: 'SNIP1_SE_SEGMENT_COUNT_MISMATCH',
        message: `SE01 claimed segment count (${claimedCount}) does not match actual segment count (${actualCount})`,
        segment: 'SE',
        elementPosition: 1,
      });
    }
  }

  if (maxLevel <= 1) {
    return buildResult(1, maxLevel, level1Errors, level2Errors, level3Errors, level4Errors);
  }

  // =========================================================================
  // SNIP Level 2: HIPAA Implementation Guide Specific Requirements & Data Types
  // =========================================================================
  const txType = getElement(stSegments[0], 1)?.trim() || '';

  interface MandatoryRule {
    readonly tag: string;
    readonly elem1?: string;
    readonly name: string;
  }

  const MANDATORY_TX_SEGMENTS: Readonly<Record<string, readonly MandatoryRule[]>> = {
    '837': [
      { tag: 'BHT', name: 'BHT' },
      { tag: 'NM1', elem1: '41', name: 'Submitter NM1*41' },
      { tag: 'NM1', elem1: '40', name: 'Receiver NM1*40' },
      { tag: 'CLM', name: 'CLM' },
      { tag: 'HI', name: 'HI diagnosis' },
      { tag: 'LX', name: 'LX service line' },
      { tag: 'SV1', name: 'SV1/SV2 service line charge' },
    ],
    '835': [
      { tag: 'BPR', name: 'BPR' },
      { tag: 'TRN', name: 'TRN trace' },
      { tag: 'N1', elem1: 'PR', name: 'Payer N1*PR' },
      { tag: 'N1', elem1: 'PE', name: 'Payee N1*PE' },
      { tag: 'CLP', name: 'CLP claim payment' },
    ],
    '270': [
      { tag: 'BHT', name: 'BHT' },
      { tag: 'NM1', elem1: 'PR', name: 'Payer NM1*PR' },
      { tag: 'NM1', elem1: '1P', name: 'Provider NM1*1P' },
      { tag: 'NM1', elem1: 'IL', name: 'Subscriber NM1*IL' },
    ],
    '271': [
      { tag: 'BHT', name: 'BHT' },
      { tag: 'NM1', elem1: 'PR', name: 'Payer NM1*PR' },
      { tag: 'NM1', elem1: '1P', name: 'Provider NM1*1P' },
      { tag: 'NM1', elem1: 'IL', name: 'Subscriber NM1*IL' },
    ],
  };

  const mandatoryRules = MANDATORY_TX_SEGMENTS[txType] ?? [];
  for (const rule of mandatoryRules) {
    let found = false;
    for (const s of segments) {
      if (rule.tag === 'SV1' && (s.tag === 'SV1' || s.tag === 'SV2')) {
        found = true;
        break;
      }
      if (s.tag === rule.tag && (!rule.elem1 || getElement(s, 1) === rule.elem1)) {
        found = true;
        break;
      }
    }
    if (!found) {
      level2Errors.push({
        level: 2,
        code: 'SNIP2_MANDATORY_SEGMENT_MISSING',
        message: `Mandatory ${rule.name} segment missing in ${txType} transaction`,
      });
    }
  }

  interface DateFieldRule {
    readonly tag: string;
    readonly pos: number;
    readonly reqQualPos?: number;
    readonly reqQualVal?: string;
    readonly name: string;
  }

  const DATE_RULES: readonly DateFieldRule[] = [
    { tag: 'DTP', pos: 3, reqQualPos: 2, reqQualVal: 'D8', name: 'DTP03 date' },
    { tag: 'DMG', pos: 2, name: 'DMG02 birth date' },
    { tag: 'BPR', pos: 16, name: 'BPR16 payment date' },
  ];

  interface NumericFieldRule {
    readonly tag: string;
    readonly pos: number;
    readonly name: string;
  }

  const NUMERIC_RULES: readonly NumericFieldRule[] = [
    { tag: 'CLM', pos: 2, name: 'CLM02 total billed charge' },
    { tag: 'SV1', pos: 2, name: 'SV102 line charge' },
  ];

  // Element Data Type Validation across all segments via table iteration
  for (const seg of segments) {
    for (const dRule of DATE_RULES) {
      const matchesTag = seg.tag === dRule.tag;
      const matchesQual = !dRule.reqQualPos || getElement(seg, dRule.reqQualPos) === dRule.reqQualVal;
      if (matchesTag && matchesQual) {
        const dt = getElement(seg, dRule.pos)?.trim();
        if (dt && !isValidDate(dt)) {
          level2Errors.push({
            level: 2,
            code: 'SNIP2_INVALID_DATE_FORMAT',
            message: `${dRule.name} (${dt}) is not a valid Gregorian YYYYMMDD date`,
            segment: seg.tag,
            elementPosition: dRule.pos,
            line: seg.index,
          });
        }
      }
    }

    for (const nRule of NUMERIC_RULES) {
      if (seg.tag === nRule.tag && getElement(seg, nRule.pos)) {
        const val = getElement(seg, nRule.pos);
        const num = Number(val);
        if (isNaN(num) || num < 0) {
          level2Errors.push({
            level: 2,
            code: 'SNIP2_INVALID_NUMERIC_ELEMENT',
            message: `${nRule.name} (${val}) is not a valid positive number`,
            segment: seg.tag,
            elementPosition: nRule.pos,
            line: seg.index,
          });
        }
      }
    }
  }

  if (maxLevel <= 2) {
    return buildResult(2, maxLevel, level1Errors, level2Errors, level3Errors, level4Errors);
  }

  // =========================================================================
  // SNIP Level 3: Balance & Arithmetic Integrity
  // =========================================================================
  if (txType === '837') {
    let currentClaimId = '';
    let claimedTotal = 0;
    let computedLineSum = 0;
    let claimFound = false;

    for (const seg of segments) {
      if (seg.tag === 'CLM') {
        if (claimFound) {
          if (Math.abs(claimedTotal - computedLineSum) > 0.01) {
            level3Errors.push({
              level: 3,
              code: 'SNIP3_CLAIM_CHARGE_MISMATCH',
              message: `Claim ${currentClaimId} total charge (${claimedTotal.toFixed(2)}) does not equal sum of service lines (${computedLineSum.toFixed(2)})`,
              segment: 'CLM',
              elementPosition: 2,
            });
          }
        }
        claimFound = true;
        currentClaimId = getElement(seg, 1) || 'UNKNOWN';
        claimedTotal = Number(getElement(seg, 2)) || 0;
        computedLineSum = 0;
      } else if (seg.tag === 'SV1') {
        computedLineSum += Number(getElement(seg, 2)) || 0;
      } else if (seg.tag === 'SV2') {
        computedLineSum += Number(getElement(seg, 3)) || 0;
      }
    }

    if (claimFound && Math.abs(claimedTotal - computedLineSum) > 0.01) {
      level3Errors.push({
        level: 3,
        code: 'SNIP3_CLAIM_CHARGE_MISMATCH',
        message: `Claim ${currentClaimId} total charge (${claimedTotal.toFixed(2)}) does not equal sum of service lines (${computedLineSum.toFixed(2)})`,
        segment: 'CLM',
        elementPosition: 2,
      });
    }
  } else if (txType === '835') {
    const bpr = segments.find((s) => s.tag === 'BPR');
    if (bpr) {
      const bprAmount = Number(getElement(bpr, 2)) || 0;
      let clpSum = 0;

      for (const seg of segments) {
        if (seg.tag === 'CLP') {
          clpSum += Number(getElement(seg, 4)) || 0;
        }
      }

      if (Math.abs(bprAmount - clpSum) > 0.01) {
        level3Errors.push({
          level: 3,
          code: 'SNIP3_REMITTANCE_TOTAL_MISMATCH',
          message: `BPR02 remittance payment amount (${bprAmount.toFixed(2)}) does not match sum of claim payments CLP04 (${clpSum.toFixed(2)})`,
          segment: 'BPR',
          elementPosition: 2,
        });
      }
    }
  }

  if (maxLevel <= 3) {
    return buildResult(3, maxLevel, level1Errors, level2Errors, level3Errors, level4Errors);
  }

  // =========================================================================
  // SNIP Level 4: Inter-Segment & Situational Field Relationships
  // =========================================================================
  for (const seg of segments) {
    // 1. NPI Luhn Check on NM1 segments with qualifier XX (NM108=XX -> NM109=NPI)
    if (seg.tag === 'NM1' && getElement(seg, 8) === 'XX') {
      const npi = getElement(seg, 9)?.trim();
      if (npi && !validateNpiLuhn(npi)) {
        level4Errors.push({
          level: 4,
          code: 'SNIP4_INVALID_NPI_LUHN',
          message: `NPI (${npi}) in segment NM1*${getElement(seg, 1)} failed CMS Modulo-10 Luhn check digit verification`,
          segment: 'NM1',
          elementPosition: 9,
          line: seg.index,
        });
      }
    }

    // 2. Provider Taxonomy Code (PRV01=BI/PE, PRV02=PXC -> PRV03 must be 10 alphanumeric ending in X)
    if (seg.tag === 'PRV' && (getElement(seg, 1) === 'BI' || getElement(seg, 1) === 'PE') && getElement(seg, 2) === 'PXC') {
      const taxCode = getElement(seg, 3)?.trim();
      if (taxCode && !isValidTaxonomyCode(taxCode)) {
        level4Errors.push({
          level: 4,
          code: 'SNIP4_INVALID_TAXONOMY_CODE',
          message: `Provider taxonomy code (${taxCode}) does not match valid 10-character Healthcare Provider Taxonomy format`,
          segment: 'PRV',
          elementPosition: 3,
          line: seg.index,
        });
      }
    }

    // 3. ICD-10-CM Diagnosis Code format validation (HI segment)
    if (seg.tag === 'HI') {
      for (let i = 1; i < seg.elements.length; i++) {
        const elem = seg.elements[i];
        if (!elem) continue;
        const parts = elem.split(':');
        const qual = parts[0]?.toUpperCase();
        const code = parts[1];
        if (code && (qual === 'BK' || qual === 'ABK' || qual === 'BF' || qual === 'ABF')) {
          if (!isValidIcd10(code)) {
            level4Errors.push({
              level: 4,
              code: 'SNIP4_INVALID_ICD10_CODE',
              message: `Diagnosis code (${code}) with qualifier ${qual} does not match valid ICD-10-CM format`,
              segment: 'HI',
              elementPosition: i,
              line: seg.index,
            });
          }
        }
      }
    }

    // 4. Procedure Code format validation (SV1 segment)
    if (seg.tag === 'SV1') {
      const comp = getElement(seg, 1);
      if (comp) {
        const parts = comp.split(':');
        const qual = parts[0]?.toUpperCase();
        const code = parts[1];
        if (qual === 'HC' && code && !isValidProcedureCode(code)) {
          level4Errors.push({
            level: 4,
            code: 'SNIP4_INVALID_PROCEDURE_CODE',
            message: `Procedure code (${code}) in SV1 does not match valid CPT or HCPCS format`,
            segment: 'SV1',
            elementPosition: 1,
            line: seg.index,
          });
        }
      }
    }
  }

  // 5. Subscriber vs Patient Hierarchical Level consistency
  const sbrSeg = segments.find((s) => s.tag === 'SBR');
  if (sbrSeg) {
    const relationship = getElement(sbrSeg, 2)?.trim(); // SBR02 is relationship
    const patientHl = segments.find((s) => s.tag === 'HL' && getElement(s, 3) === '23');

    if (relationship === '18' && patientHl) {
      level4Errors.push({
        level: 4,
        code: 'SNIP4_SUBSCRIBER_PATIENT_CONFLICT',
        message: 'Subscriber relationship is Self (SBR02=18); subordinate Patient hierarchical level (HL03=23) must not be present',
        segment: 'HL',
        elementPosition: 3,
        line: patientHl.index,
      });
    }
  }


  return buildResult(4, maxLevel, level1Errors, level2Errors, level3Errors, level4Errors);
}

function buildResult(
  evaluatedLevel: SnipLevel,
  maxLevel: SnipLevel,
  l1: SnipIssue[],
  l2: SnipIssue[],
  l3: SnipIssue[],
  l4: SnipIssue[]
): SnipValidationResult {
  const allErrors = [l1, l2, l3, l4].slice(0, maxLevel).flat();
  const passed = allErrors.length === 0;

  return {
    level: maxLevel,
    passed,
    levels: {
      level1: { passed: l1.length === 0, errors: l1 },
      level2: { passed: l2.length === 0, errors: l2 },
      level3: { passed: l3.length === 0, errors: l3 },
      level4: { passed: l4.length === 0, errors: l4 },
    },
    errors: allErrors,
  };
}
