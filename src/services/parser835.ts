import {
  ParsedSegment,
  Remittance835Transaction,
  ClaimPayment835,
  ServicePayment835,
  Adjustment835,
} from '../types/index.js';
import { getElement, optStr, optObj, parseEdiNumber, splitComposite } from './tokenizer.js';

const formatFullName = (first: string, last: string): string =>
  (first ? `${first} ${last}` : last).trim();

const extractAdjustments = (seg: ParsedSegment): Adjustment835[] => {
  const groupCode = getElement(seg, 1);
  const adjustments: Adjustment835[] = [];

  for (let idx = 2; idx < seg.elements.length; idx += 3) {
    const reasonCode = getElement(seg, idx);
    const amount = parseEdiNumber(getElement(seg, idx + 1));
    const rawQty = getElement(seg, idx + 2);
    const qty = rawQty ? parseEdiNumber(rawQty) : undefined;
    if (reasonCode) {
      adjustments.push({
        groupCode,
        reasonCode,
        amount,
        quantity: qty,
      });
    }
  }
  return adjustments;
};

interface State835 {
  totalPaymentAmount: number;
  paymentMethod: string;
  paymentDate: string;
  checkOrTrace: string;
  payerName: string;
  payerId: string;
  payerAddress: { street?: string; city?: string; state?: string; zip?: string };
  payeeName: string;
  payeeNpi: string;
  payeeTaxId: string;
  claimPayments: ClaimPayment835[];
  currentClaim: ClaimPayment835 | null;
  currentService: ServicePayment835 | null;
  currentLoop: string;
}

const flushService = (state: State835): void => {
  if (state.currentClaim && state.currentService) {
    state.currentClaim.services.push(state.currentService);
    state.currentService = null;
  }
};

const flushClaim = (state: State835): void => {
  flushService(state);
  if (state.currentClaim) {
    state.claimPayments.push(state.currentClaim);
    state.currentClaim = null;
  }
};

const handlers: Record<string, (seg: ParsedSegment, state: State835) => void> = {
  BPR: (seg, state) => {
    state.totalPaymentAmount = parseEdiNumber(getElement(seg, 2));
    state.paymentMethod = getElement(seg, 4) || 'CHK';
    state.paymentDate = getElement(seg, 16);
  },

  TRN: (seg, state) => {
    state.checkOrTrace = getElement(seg, 2);
  },

  N1: (seg, state) => {
    const entityId = getElement(seg, 1);
    const name = getElement(seg, 2);
    const qual = getElement(seg, 3);
    const idVal = getElement(seg, 4);

    if (entityId === 'PR') {
      state.currentLoop = '1000A';
      state.payerName = name;
      state.payerId = idVal;
    }
    if (entityId === 'PE') {
      state.currentLoop = '1000B';
      state.payeeName = name;
      if (qual === 'XX') {
        state.payeeNpi = idVal;
      } else {
        state.payeeTaxId = idVal;
      }
    }
  },

  REF: (seg, state) => {
    const qualifier = getElement(seg, 1);
    const refId = getElement(seg, 2);
    if (state.currentLoop === '1000B' && ['TJ', 'FI', '24', 'F2', 'EI'].includes(qualifier)) {
      state.payeeTaxId = refId;
    }
  },

  N3: (seg, state) => {
    if (state.currentLoop === '1000A') {
      state.payerAddress.street = getElement(seg, 1);
    }
  },

  N4: (seg, state) => {
    if (state.currentLoop === '1000A') {
      state.payerAddress.city = getElement(seg, 1);
      state.payerAddress.state = getElement(seg, 2);
      state.payerAddress.zip = getElement(seg, 3);
    }
  },

  CLP: (seg, state) => {
    flushClaim(state);
    state.currentLoop = '2100';
    state.currentClaim = {
      patientControlNumber: getElement(seg, 1),
      claimStatusCode: getElement(seg, 2),
      totalCharge: parseEdiNumber(getElement(seg, 3)),
      totalPaid: parseEdiNumber(getElement(seg, 4)),
      patientResponsibility: parseEdiNumber(getElement(seg, 5)),
      payerClaimControlNumber: optStr(getElement(seg, 7)),
      patient: { name: '' },
      adjustments: [],
      services: [],
    };
  },

  NM1: (seg, state) => {
    if (state.currentClaim && state.currentLoop === '2100') {
      state.currentClaim.patient.name = formatFullName(
        getElement(seg, 4),
        getElement(seg, 3),
      );
      state.currentClaim.patient.memberId = optStr(getElement(seg, 9));
    }
  },

  CAS: (seg, state) => {
    const adjs = extractAdjustments(seg);
    if (state.currentLoop === '2110' && state.currentService) {
      state.currentService.adjustments.push(...adjs);
    } else if (state.currentClaim) {
      state.currentClaim.adjustments.push(...adjs);
    }
  },

  SVC: (seg, state) => {
    if (state.currentClaim) {
      flushService(state);
      state.currentLoop = '2110';
      const procComp = getElement(seg, 1);
      const parts = splitComposite(procComp);
      const procCode = parts.length > 1 ? parts[1] : parts[0];
      const units = parseEdiNumber(getElement(seg, 5));
      state.currentService = {
        procedureCode: procCode,
        chargeAmount: parseEdiNumber(getElement(seg, 2)),
        paidAmount: parseEdiNumber(getElement(seg, 3)),
        unitsPaid: units > 0 ? units : undefined,
        adjustments: [],
      };
    }
  },

  DTM: (seg, state) => {
    if (state.currentService && (getElement(seg, 1) === '472' || getElement(seg, 1) === '150')) {
      state.currentService.serviceDate = getElement(seg, 2);
    }
  },
};

export function parse835Transaction(segments: ParsedSegment[]): Remittance835Transaction {
  const stSegment = segments.find((s) => s.tag === 'ST');
  const controlNumber = stSegment ? getElement(stSegment, 2) : '';

  const state: State835 = {
    totalPaymentAmount: 0,
    paymentMethod: 'CHK',
    paymentDate: '',
    checkOrTrace: '',
    payerName: '',
    payerId: '',
    payerAddress: {},
    payeeName: '',
    payeeNpi: '',
    payeeTaxId: '',
    claimPayments: [],
    currentClaim: null,
    currentService: null,
    currentLoop: '',
  };

  for (const seg of segments) {
    if (handlers[seg.tag]) {
      handlers[seg.tag](seg, state);
    }
  }

  flushClaim(state);

  return {
    transactionType: '835',
    controlNumber,
    paymentInfo: {
      totalAmount: state.totalPaymentAmount,
      paymentMethod: state.paymentMethod,
      paymentDate: state.paymentDate,
      checkOrEftTraceNumber: optStr(state.checkOrTrace),
    },
    payer: {
      name: state.payerName,
      id: optStr(state.payerId),
      address: optObj(state.payerAddress),
    },
    payee: {
      name: state.payeeName,
      npi: optStr(state.payeeNpi),
      taxId: optStr(state.payeeTaxId),
    },
    claimPayments: state.claimPayments,
  };
}
