import {
  ParsedSegment,
  Eligibility271Transaction,
  BenefitItem271,
} from '../types/index.js';
import { getElement, optStr, parseEdiNumber } from './tokenizer.js';

export const ELIGIBILITY_CODE_DESCRIPTIONS: Record<string, string> = {
  '1': 'Active Coverage',
  '2': 'Active - Full Risk Capitation',
  '3': 'Active - Services Specified',
  '4': 'Active - Out of Area',
  '5': 'Active - Pending Investigation',
  '6': 'Inactive',
  '7': 'Inactive - Pending Eligibility Update',
  '8': 'Inactive - Pending Investigation',
  'A': 'Co-Insurance',
  'B': 'Co-Payment',
  'C': 'Deductible',
  'D': 'Benefit Description',
  'E': 'Exclusions',
  'F': 'Limitations',
  'G': 'Out of Pocket (Stop Loss)',
  'U': 'Contact Payer',
  'V': 'Cannot Provide Information',
  'Y': 'Spend Down',
};

export const SERVICE_TYPE_DESCRIPTIONS: Record<string, string> = {
  '1': 'Medical Care',
  '30': 'Health Benefit Plan Coverage',
  '33': 'Chiropractic',
  '35': 'Dental Care',
  '47': 'Hospital - Inpatient',
  '48': 'Hospital - Outpatient',
  '50': 'Hospital - Emergency',
  '86': 'Emergency Services',
  '88': 'Pharmacy',
  '98': 'Professional (Physician) Visit - Office',
  'AL': 'Vision (Optometry)',
  'MH': 'Mental Health',
  'UC': 'Urgent Care',
};

export function getEligibilityDescription(code: string): string {
  return ELIGIBILITY_CODE_DESCRIPTIONS[code] || `Eligibility Code ${code}`;
}

export function getServiceTypeDescription(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return SERVICE_TYPE_DESCRIPTIONS[code] || `Service Type ${code}`;
}

const formatFullName = (first: string, last: string): string =>
  (first ? `${first} ${last}` : last).trim();

interface State271 {
  infoSourceName: string;
  infoSourceId: string;
  infoReceiverName: string;
  infoReceiverId: string;
  subscriberName: string;
  subscriberMemberId: string;
  subscriberDob: string;
  subscriberGender: string;
  subscriberPlan: string;
  benefits: BenefitItem271[];
  currentLoop: string;
}

const handlers: Record<string, (seg: ParsedSegment, state: State271) => void> = {
  NM1: (seg, state) => {
    const entityId = getElement(seg, 1);
    const lastName = getElement(seg, 3);
    const firstName = getElement(seg, 4);
    const fullName = formatFullName(firstName, lastName);
    const idCode = getElement(seg, 9) || getElement(seg, 5) || getElement(seg, 4);

    if (entityId === 'PR' || entityId === '20') {
      state.currentLoop = '2100A';
      state.infoSourceName = fullName;
      state.infoSourceId = idCode;
    }
    if (entityId === '1P' || entityId === '21' || entityId === 'FA') {
      state.currentLoop = '2100B';
      state.infoReceiverName = fullName;
      state.infoReceiverId = idCode;
    }
    if (entityId === 'IL') {
      state.currentLoop = '2100C';
      state.subscriberName = fullName;
      state.subscriberMemberId = idCode;
    }
  },

  DMG: (seg, state) => {
    if (state.currentLoop === '2100C') {
      state.subscriberDob = getElement(seg, 2);
      state.subscriberGender = getElement(seg, 3);
    }
  },

  REF: (seg, state) => {
    if (state.currentLoop === '2100C') {
      state.subscriberPlan = getElement(seg, 2);
    }
  },

  EB: (seg, state) => {
    state.currentLoop = '2110C';
    const eligCode = getElement(seg, 1);
    const coverageLevel = getElement(seg, 2);
    const serviceTypeCode = getElement(seg, 3);

    let amount: number | undefined;
    let percent: number | undefined;

    for (let i = 5; i < seg.elements.length; i++) {
      const val = getElement(seg, i);
      if (val.length > 0) {
        const firstCode = val.charCodeAt(0);
        if (firstCode >= 48 && firstCode <= 57) {
          const num = parseEdiNumber(val);
          if (eligCode === 'A') {
            percent = num;
          } else if (amount === undefined) {
            amount = num;
          }
        }
      }
    }

    const benefit: BenefitItem271 = {
      eligibilityCode: eligCode,
      eligibilityDescription: getEligibilityDescription(eligCode),
      serviceTypeCode: optStr(serviceTypeCode),
      serviceTypeDescription: getServiceTypeDescription(optStr(serviceTypeCode)),
      coverageLevel: optStr(coverageLevel),
      copayAmount: eligCode === 'B' ? amount : undefined,
      coinsurancePercent: percent,
      deductibleAmount: eligCode === 'C' ? amount : undefined,
      outOfPocketMax: eligCode === 'G' ? amount : undefined,
    };

    state.benefits.push(benefit);
  },
};

export function parse271Transaction(segments: ParsedSegment[]): Eligibility271Transaction {
  const stSegment = segments.find((s) => s.tag === 'ST');
  const controlNumber = stSegment ? getElement(stSegment, 2) : '';

  const state: State271 = {
    infoSourceName: '',
    infoSourceId: '',
    infoReceiverName: '',
    infoReceiverId: '',
    subscriberName: '',
    subscriberMemberId: '',
    subscriberDob: '',
    subscriberGender: '',
    subscriberPlan: '',
    benefits: [],
    currentLoop: '',
  };

  for (const seg of segments) {
    if (handlers[seg.tag]) {
      handlers[seg.tag](seg, state);
    }
  }

  return {
    transactionType: '271',
    controlNumber,
    informationSource: {
      name: state.infoSourceName,
      id: optStr(state.infoSourceId),
    },
    informationReceiver: {
      name: state.infoReceiverName,
      id: optStr(state.infoReceiverId),
    },
    subscriber: {
      name: state.subscriberName,
      memberId: state.subscriberMemberId,
      dateOfBirth: optStr(state.subscriberDob),
      gender: optStr(state.subscriberGender),
      planNumber: optStr(state.subscriberPlan),
    },
    benefits: state.benefits,
  };
}
