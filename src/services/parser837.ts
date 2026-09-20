import {
  ParsedSegment,
  Claim837Transaction,
  Claim837,
  ServiceLine837,
} from '../types/index.js';
import { getElement, optStr, optObj, parseEdiNumber, splitComposite } from './tokenizer.js';

const formatFullName = (first: string, last: string): string =>
  (first ? `${first} ${last}` : last).trim();

export enum FsmState837 {
  START = 'START',
  HEADER = 'HEADER',
  LOOP_1000A = 'LOOP_1000A',       // Submitter (NM1*41, PER*IC)
  LOOP_1000B = 'LOOP_1000B',       // Receiver (NM1*40)
  LOOP_2000A = 'LOOP_2000A',       // Billing Provider HL (20)
  LOOP_2010AA = 'LOOP_2010AA',     // Billing Provider Name (NM1*85, N3, N4, REF)
  LOOP_2010AB = 'LOOP_2010AB',     // Pay-To Provider (NM1*87)
  LOOP_2000B = 'LOOP_2000B',       // Subscriber HL (22, SBR)
  LOOP_2010BA = 'LOOP_2010BA',     // Subscriber Name (NM1*IL, N3, N4, DMG)
  LOOP_2010BB = 'LOOP_2010BB',     // Payer Name (NM1*PR, N3, N4)
  LOOP_2000C = 'LOOP_2000C',       // Patient/Dependent HL (23, PAT)
  LOOP_2010CA = 'LOOP_2010CA',     // Patient Name (NM1*QC, N3, N4, DMG)
  LOOP_2300 = 'LOOP_2300',         // Claim (CLM, DTP, CL1, REF, HI)
  LOOP_2310A = 'LOOP_2310A',       // Referring Provider (NM1*DN)
  LOOP_2310B = 'LOOP_2310B',       // Rendering Provider (NM1*82)
  LOOP_2310C = 'LOOP_2310C',       // Service Facility (NM1*77)
  LOOP_2310D = 'LOOP_2310D',       // Supervising Provider (NM1*DQ)
  LOOP_2400 = 'LOOP_2400',         // Service Line (LX, SV1, SV2, SV3, DTP, REF)
  LOOP_2410 = 'LOOP_2410',         // Drug Information (LIN, CTP)
  LOOP_2420A = 'LOOP_2420A',       // Line Rendering Provider (NM1*82)
  LOOP_2420C = 'LOOP_2420C',       // Line Service Facility (NM1*77)
  TRAILER = 'TRAILER',             // SE
}

interface SubscriberRecord {
  memberId: string;
  name: string;
  address: { street?: string; city?: string; state?: string; zip?: string };
  dateOfBirth?: string;
  gender?: string;
  payer?: { name: string; payerId?: string };
  patient?: {
    name?: string;
    memberId?: string;
    dateOfBirth?: string;
    gender?: string;
    relationship?: string;
  };
}

interface FsmContext837 {
  state: FsmState837;
  transactionType: string;
  controlNumber: string;
  
  // 1000A / 1000B
  submitterName: string;
  submitterId: string;
  submitterContact?: { name?: string; phone?: string; email?: string };
  receiverName: string;
  receiverId: string;

  // 2000A Billing Provider
  billingProviderName: string;
  billingProviderNpi: string;
  billingProviderTaxId: string;
  billingAddress: { street?: string; city?: string; state?: string; zip?: string };

  // Current Subscriber & Sub-records
  currentSubscriber: SubscriberRecord;
  subscribers: SubscriberRecord[];

  // Claims
  allClaims: Claim837[];
  currentClaim: Claim837 | null;
  currentServiceLine: ServiceLine837 | null;
}

function createInitialContext(): FsmContext837 {
  return {
    state: FsmState837.START,
    transactionType: '837P',
    controlNumber: '',
    submitterName: '',
    submitterId: '',
    receiverName: '',
    receiverId: '',
    billingProviderName: '',
    billingProviderNpi: '',
    billingProviderTaxId: '',
    billingAddress: {},
    currentSubscriber: {
      memberId: '',
      name: '',
      address: {},
    },
    subscribers: [],
    allClaims: [],
    currentClaim: null,
    currentServiceLine: null,
  };
}

function flushServiceLine(ctx: FsmContext837): void {
  if (ctx.currentClaim && ctx.currentServiceLine) {
    ctx.currentClaim.serviceLines.push(ctx.currentServiceLine);
    ctx.currentServiceLine = null;
  }
}

function flushClaim(ctx: FsmContext837): void {
  flushServiceLine(ctx);
  if (ctx.currentClaim) {
    // If patient is in 2000C, attach patient info to claim if not already set
    if (!ctx.currentClaim.patient && ctx.currentSubscriber.patient) {
      ctx.currentClaim.patient = ctx.currentSubscriber.patient;
    }
    ctx.allClaims.push(ctx.currentClaim);
    ctx.currentClaim = null;
  }
}

function flushSubscriber(ctx: FsmContext837): void {
  flushClaim(ctx);
  if (ctx.currentSubscriber.name || ctx.currentSubscriber.memberId) {
    ctx.subscribers.push({ ...ctx.currentSubscriber });
  }
}

/**
 * Executes a single state transition in the 837 Hierarchical Loop Finite State Machine.
 */
export function transition837(ctx: FsmContext837, seg: ParsedSegment): void {
  const tag = seg.tag;

  switch (tag) {
    case 'ST': {
      ctx.state = FsmState837.HEADER;
      const subtype = getElement(seg, 1);
      if (subtype === '837') {
        const standard = getElement(seg, 3);
        if (standard.includes('X223')) ctx.transactionType = '837I';
        else if (standard.includes('X224')) ctx.transactionType = '837D';
        else ctx.transactionType = '837P';
      }
      ctx.controlNumber = getElement(seg, 2);
      break;
    }

    case 'BHT': {
      ctx.state = FsmState837.HEADER;
      break;
    }

    case 'HL': {
      const hlLevel = getElement(seg, 3);
      if (hlLevel === '20') {
        // Billing Provider HL
        ctx.state = FsmState837.LOOP_2000A;
      } else if (hlLevel === '22') {
        // Subscriber HL
        flushSubscriber(ctx);
        ctx.state = FsmState837.LOOP_2000B;
        ctx.currentSubscriber = {
          memberId: '',
          name: '',
          address: {},
        };
      } else if (hlLevel === '23') {
        // Dependent / Patient HL
        ctx.state = FsmState837.LOOP_2000C;
      }
      break;
    }

    case 'PRV': {
      // Provider specialty
      break;
    }

    case 'SBR': {
      if (ctx.state === FsmState837.LOOP_2000B) {
        // Subscriber info
      }
      break;
    }

    case 'PAT': {
      if (ctx.state === FsmState837.LOOP_2000C) {
        const relationship = getElement(seg, 1);
        if (!ctx.currentSubscriber.patient) {
          ctx.currentSubscriber.patient = {};
        }
        ctx.currentSubscriber.patient.relationship = relationship;
      }
      break;
    }

    case 'NM1': {
      const entityId = getElement(seg, 1);
      const lastName = getElement(seg, 3);
      const firstName = getElement(seg, 4);
      const fullName = formatFullName(firstName, lastName);
      const idCode = getElement(seg, 9) || getElement(seg, 5);

      if (entityId === '41') {
        ctx.state = FsmState837.LOOP_1000A;
        ctx.submitterName = fullName;
        ctx.submitterId = idCode;
      } else if (entityId === '40') {
        ctx.state = FsmState837.LOOP_1000B;
        ctx.receiverName = fullName;
        ctx.receiverId = idCode;
      } else if (entityId === '85') {
        ctx.state = FsmState837.LOOP_2010AA;
        ctx.billingProviderName = fullName;
        ctx.billingProviderNpi = idCode;
      } else if (entityId === 'IL') {
        ctx.state = FsmState837.LOOP_2010BA;
        ctx.currentSubscriber.name = fullName;
        ctx.currentSubscriber.memberId = idCode;
      } else if (entityId === 'PR') {
        ctx.state = FsmState837.LOOP_2010BB;
        ctx.currentSubscriber.payer = {
          name: fullName,
          payerId: optStr(idCode),
        };
      } else if (entityId === 'QC') {
        ctx.state = FsmState837.LOOP_2010CA;
        if (!ctx.currentSubscriber.patient) ctx.currentSubscriber.patient = {};
        ctx.currentSubscriber.patient.name = fullName;
        ctx.currentSubscriber.patient.memberId = optStr(idCode);
      } else if (entityId === 'DN') {
        ctx.state = FsmState837.LOOP_2310A;
        if (ctx.currentClaim) {
          ctx.currentClaim.referringProvider = { name: fullName, npi: optStr(idCode) };
        }
      } else if (entityId === '82') {
        if (ctx.state === FsmState837.LOOP_2400 && ctx.currentServiceLine) {
          ctx.currentServiceLine.renderingProviderNpi = optStr(idCode);
        } else if (ctx.currentClaim) {
          ctx.currentClaim.renderingProvider = { name: fullName, npi: optStr(idCode) };
        }
      } else if (entityId === '77') {
        if (ctx.currentClaim) {
          ctx.state = FsmState837.LOOP_2310C;
          ctx.currentClaim.serviceFacility = { name: fullName, npi: optStr(idCode) };
        }
      }
      break;
    }

    case 'PER': {
      if (ctx.state === FsmState837.LOOP_1000A) {
        const contactName = getElement(seg, 2);
        let phone: string | undefined;
        let email: string | undefined;

        for (let idx = 3; idx < seg.elements.length; idx += 2) {
          const qual = getElement(seg, idx);
          const val = getElement(seg, idx + 1);
          if (qual === 'TE' && !phone) phone = val;
          else if (qual === 'EM' && !email) email = val;
        }

        ctx.submitterContact = {
          name: optStr(contactName),
          phone: optStr(phone),
          email: optStr(email),
        };
      }
      break;
    }

    case 'N3': {
      const street = getElement(seg, 1);
      if (ctx.state === FsmState837.LOOP_2010AA || ctx.state === FsmState837.LOOP_2000A) {
        ctx.billingAddress.street = street;
      } else if (ctx.state === FsmState837.LOOP_2010BA || ctx.state === FsmState837.LOOP_2000B) {
        ctx.currentSubscriber.address.street = street;
      } else if (ctx.state === FsmState837.LOOP_2310C && ctx.currentClaim?.serviceFacility) {
        ctx.currentClaim.serviceFacility.address = { street };
      }
      break;
    }

    case 'N4': {
      const city = getElement(seg, 1);
      const stateVal = getElement(seg, 2);
      const zip = getElement(seg, 3);
      if (ctx.state === FsmState837.LOOP_2010AA || ctx.state === FsmState837.LOOP_2000A) {
        ctx.billingAddress.city = city;
        ctx.billingAddress.state = stateVal;
        ctx.billingAddress.zip = zip;
      } else if (ctx.state === FsmState837.LOOP_2010BA || ctx.state === FsmState837.LOOP_2000B) {
        ctx.currentSubscriber.address.city = city;
        ctx.currentSubscriber.address.state = stateVal;
        ctx.currentSubscriber.address.zip = zip;
      } else if (ctx.state === FsmState837.LOOP_2310C && ctx.currentClaim?.serviceFacility) {
        const addr = ctx.currentClaim.serviceFacility.address || {};
        addr.city = city;
        addr.state = stateVal;
        addr.zip = zip;
        ctx.currentClaim.serviceFacility.address = addr;
      }
      break;
    }

    case 'REF': {
      const qualifier = getElement(seg, 1);
      const refId = getElement(seg, 2);

      if (ctx.state === FsmState837.LOOP_2010AA || ctx.state === FsmState837.LOOP_2000A) {
        if (qualifier === 'EI' || qualifier === 'SY') {
          ctx.billingProviderTaxId = refId;
        }
      } else if (ctx.state === FsmState837.LOOP_2400 && ctx.currentServiceLine) {
        if (qualifier === '6R') {
          ctx.currentServiceLine.lineItemControlNumber = refId;
        }
      } else if (ctx.currentClaim) {
        if (qualifier === 'G1') {
          ctx.currentClaim.priorAuthNumber = refId;
        }
      }
      break;
    }

    case 'DMG': {
      const dob = getElement(seg, 2);
      const gender = getElement(seg, 3);
      if (ctx.state === FsmState837.LOOP_2010BA || ctx.state === FsmState837.LOOP_2000B) {
        ctx.currentSubscriber.dateOfBirth = optStr(dob);
        ctx.currentSubscriber.gender = optStr(gender);
      } else if (ctx.state === FsmState837.LOOP_2010CA || ctx.state === FsmState837.LOOP_2000C) {
        if (!ctx.currentSubscriber.patient) ctx.currentSubscriber.patient = {};
        ctx.currentSubscriber.patient.dateOfBirth = optStr(dob);
        ctx.currentSubscriber.patient.gender = optStr(gender);
      }
      break;
    }

    case 'CLM': {
      flushClaim(ctx);
      ctx.state = FsmState837.LOOP_2300;
      const submitterClaimId = getElement(seg, 1);
      const chargeAmount = parseEdiNumber(getElement(seg, 2));
      const facilityComposite = getElement(seg, 5);
      const facParts = splitComposite(facilityComposite);
      const placeOfService = facParts[0] || facilityComposite;
      const claimFrequency = facParts[2] || getElement(seg, 6) || '1';

      ctx.currentClaim = {
        claimId: submitterClaimId,
        totalCharge: chargeAmount,
        placeOfService: optStr(placeOfService),
        claimFrequencyCode: optStr(claimFrequency),
        providerSignature: true,
        assignmentOfBenefits: true,
        releaseOfInformation: true,
        diagnosisCodes: [],
        serviceLines: [],
      };
      break;
    }

    case 'DTP': {
      const dtpQual = getElement(seg, 1);
      const dtpVal = getElement(seg, 3);
      if (ctx.state === FsmState837.LOOP_2400 && ctx.currentServiceLine) {
        ctx.currentServiceLine.serviceDate = dtpVal;
      } else if (ctx.currentClaim) {
        if (dtpQual === '435') {
          ctx.currentClaim.admissionDate = dtpVal;
        } else if (dtpQual === '096') {
          ctx.currentClaim.dischargeDate = dtpVal;
        } else {
          ctx.currentClaim.claimDate = dtpVal;
        }
      }
      break;
    }

    case 'HI': {
      if (ctx.currentClaim) {
        for (let idx = 1; idx < seg.elements.length; idx++) {
          const hiComp = getElement(seg, idx);
          if (!hiComp) continue;
          const parts = splitComposite(hiComp);
          const qual = parts.length > 1 ? parts[0] : 'BK';
          const diagCode = parts.length > 1 ? parts[1] : parts[0];
          if (diagCode) {
            ctx.currentClaim.diagnosisCodes.push({
              type: qual === 'ABK' || qual === 'ABF' ? 'ICD-10' : 'ICD-9',
              code: diagCode,
              primary: ctx.currentClaim.diagnosisCodes.length === 0,
            });
          }
        }
      }
      break;
    }

    case 'LX': {
      if (ctx.currentClaim) {
        flushServiceLine(ctx);
        ctx.state = FsmState837.LOOP_2400;
        ctx.currentServiceLine = {
          lineNumber: parseEdiNumber(getElement(seg, 1)) || 1,
          procedureCode: '',
          procedureModifiers: [],
          chargeAmount: 0,
          units: 1,
          diagnosisCodePointers: [],
          serviceType: 'professional',
        };
      }
      break;
    }

    case 'SV1': {
      // Professional Service Line
      if (ctx.currentServiceLine) {
        ctx.currentServiceLine.serviceType = 'professional';
        const parts = splitComposite(getElement(seg, 1));
        ctx.currentServiceLine.procedureCode = parts.length > 1 ? parts[1] : parts[0];
        ctx.currentServiceLine.procedureModifiers = parts.slice(2).filter((m) => m.length > 0);
        ctx.currentServiceLine.chargeAmount = parseEdiNumber(getElement(seg, 2));
        ctx.currentServiceLine.units = parseEdiNumber(getElement(seg, 4)) || 1;

        const diagPtrs = getElement(seg, 7);
        if (diagPtrs) {
          ctx.currentServiceLine.diagnosisCodePointers = splitComposite(diagPtrs).filter((p) => p.length > 0);
        }
      }
      break;
    }

    case 'SV2': {
      // Institutional Service Line (837I)
      if (ctx.currentServiceLine) {
        ctx.currentServiceLine.serviceType = 'institutional';
        ctx.currentServiceLine.revenueCode = getElement(seg, 1);
        const parts = splitComposite(getElement(seg, 2));
        ctx.currentServiceLine.procedureCode = parts.length > 1 ? parts[1] : parts[0];
        ctx.currentServiceLine.procedureModifiers = parts.slice(2).filter((m) => m.length > 0);
        ctx.currentServiceLine.chargeAmount = parseEdiNumber(getElement(seg, 3));
        ctx.currentServiceLine.units = parseEdiNumber(getElement(seg, 5)) || 1;
      }
      break;
    }

    case 'SV3': {
      // Dental Service Line (837D)
      if (ctx.currentServiceLine) {
        ctx.currentServiceLine.serviceType = 'dental';
        const parts = splitComposite(getElement(seg, 1));
        ctx.currentServiceLine.procedureCode = parts.length > 1 ? parts[1] : parts[0];
        ctx.currentServiceLine.chargeAmount = parseEdiNumber(getElement(seg, 2));
        ctx.currentServiceLine.units = parseEdiNumber(getElement(seg, 6)) || 1;
      }
      break;
    }

    case 'LIN': {
      // Drug Identification (Loop 2410)
      if (ctx.currentServiceLine) {
        ctx.state = FsmState837.LOOP_2410;
        ctx.currentServiceLine.drugInfo = {
          ndc: getElement(seg, 3),
        };
      }
      break;
    }

    case 'CTP': {
      // Drug Quantity & Pricing
      if (ctx.currentServiceLine?.drugInfo) {
        ctx.currentServiceLine.drugInfo.quantity = parseEdiNumber(getElement(seg, 4));
        ctx.currentServiceLine.drugInfo.unit = optStr(getElement(seg, 5));
      }
      break;
    }

    case 'SE': {
      flushSubscriber(ctx);
      ctx.state = FsmState837.TRAILER;
      break;
    }

    default:
      // Unknown or non-essential loop segment: maintain current state
      break;
  }
}

/**
 * Parses an 837 transaction set using a formal Hierarchical Loop Finite State Machine (FSM).
 */
export function parse837Transaction(segments: ParsedSegment[]): Claim837Transaction {
  const ctx = createInitialContext();

  for (const seg of segments) {
    transition837(ctx, seg);
  }

  // Ensure trailing claims and subscribers are flushed if SE was truncated
  if (ctx.state !== FsmState837.TRAILER) {
    flushSubscriber(ctx);
  }

  const primarySubscriber = ctx.subscribers[0] || ctx.currentSubscriber;
  const totalAmount = ctx.allClaims.reduce((sum, c) => sum + c.totalCharge, 0);

  return {
    transactionType: ctx.transactionType,
    controlNumber: ctx.controlNumber,
    submitter: {
      name: ctx.submitterName,
      identifier: optStr(ctx.submitterId),
      contact: ctx.submitterContact,
    },
    receiver: {
      name: ctx.receiverName,
      identifier: optStr(ctx.receiverId),
    },
    billingProvider: {
      name: ctx.billingProviderName,
      npi: optStr(ctx.billingProviderNpi),
      taxId: optStr(ctx.billingProviderTaxId),
      address: optObj(ctx.billingAddress),
    },
    subscriber: {
      name: primarySubscriber.name,
      memberId: primarySubscriber.memberId,
      dateOfBirth: optStr(primarySubscriber.dateOfBirth),
      gender: optStr(primarySubscriber.gender),
      address: optObj(primarySubscriber.address),
      payer: primarySubscriber.payer,
    },
    claims: ctx.allClaims,
    subscribers: ctx.subscribers.length > 1 ? ctx.subscribers : undefined,
    claimCount: ctx.allClaims.length,
    totalClaimAmount: totalAmount > 0 ? totalAmount : undefined,
  };
}
