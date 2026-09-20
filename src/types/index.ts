import { any as zodAny, array, boolean, enum as zodEnum, literal, number, object, string, union, type z } from 'zod';

export const DelimitersSchema = object({
  element: string().min(1).max(1),
  component: string().min(1).max(1),
  repetition: string().min(1).max(1).optional(),
  segment: string().min(1).max(2),
});
export type Delimiters = z.infer<typeof DelimitersSchema>;

export const SegmentSchema = object({
  tag: string(),
  elements: array(string()),
  raw: string(),
  index: number(),
});
export type ParsedSegment = z.infer<typeof SegmentSchema>;

export const InterchangeEnvelopeSchema = object({
  senderId: string(),
  senderQualifier: string(),
  receiverId: string(),
  receiverQualifier: string(),
  controlNumber: string(),
  date: string(),
  time: string(),
  version: string(),
  repetitionSeparator: string().optional(),
});
export type InterchangeEnvelope = z.infer<typeof InterchangeEnvelopeSchema>;

export const FunctionalGroupSchema = object({
  functionalCode: string(),
  senderAppCode: string(),
  receiverAppCode: string(),
  date: string(),
  time: string(),
  controlNumber: string(),
  version: string(),
});
export type FunctionalGroup = z.infer<typeof FunctionalGroupSchema>;

// 837 Professional / Institutional / Dental Claim Schemas
export const ServiceLine837Schema = object({
  lineNumber: number(),
  procedureCode: string(),
  procedureModifiers: array(string()).default([]),
  chargeAmount: number(),
  units: number().default(1),
  serviceDate: string().optional(),
  diagnosisCodePointers: array(string()).default([]),
  revenueCode: string().optional(), // For 837I Institutional claims (SV2)
  serviceType: zodEnum(['professional', 'institutional', 'dental']).default('professional'),
  lineItemControlNumber: string().optional(),
  renderingProviderNpi: string().optional(),
  drugInfo: object({
    ndc: string(),
    quantity: number().optional(),
    unit: string().optional(),
  }).optional(),
});
export type ServiceLine837 = z.infer<typeof ServiceLine837Schema>;

export const Claim837Schema = object({
  claimId: string(),
  totalCharge: number(),
  placeOfService: string().optional(),
  claimFrequencyCode: string().optional(),
  providerSignature: boolean().default(true),
  assignmentOfBenefits: boolean().default(true),
  releaseOfInformation: boolean().default(true),
  diagnosisCodes: array(object({
    type: string(), // ICD-10 (ABK/ABF) or ICD-9 (BK/BF)
    code: string(),
    primary: boolean(),
  })).default([]),
  serviceLines: array(ServiceLine837Schema).default([]),
  claimDate: string().optional(),
  admissionDate: string().optional(),
  dischargeDate: string().optional(),
  priorAuthNumber: string().optional(),
  renderingProvider: object({
    name: string().optional(),
    npi: string().optional(),
  }).optional(),
  referringProvider: object({
    name: string().optional(),
    npi: string().optional(),
  }).optional(),
  serviceFacility: object({
    name: string().optional(),
    npi: string().optional(),
    address: object({
      street: string().optional(),
      city: string().optional(),
      state: string().optional(),
      zip: string().optional(),
    }).optional(),
  }).optional(),
  patient: object({
    name: string().optional(),
    memberId: string().optional(),
    dateOfBirth: string().optional(),
    gender: string().optional(),
    relationship: string().optional(),
  }).optional(),
});
export type Claim837 = z.infer<typeof Claim837Schema>;

export const Claim837TransactionSchema = object({
  transactionType: string().default('837P'),
  controlNumber: string(),
  submitter: object({
    name: string(),
    identifier: string().optional(),
    contact: object({
      name: string().optional(),
      phone: string().optional(),
      email: string().optional(),
    }).optional(),
  }),
  receiver: object({
    name: string(),
    identifier: string().optional(),
  }),
  billingProvider: object({
    name: string(),
    npi: string().optional(),
    taxId: string().optional(),
    address: object({
      street: string().optional(),
      city: string().optional(),
      state: string().optional(),
      zip: string().optional(),
    }).optional(),
  }),
  subscriber: object({
    memberId: string(),
    name: string(),
    address: object({
      street: string().optional(),
      city: string().optional(),
      state: string().optional(),
      zip: string().optional(),
    }).optional(),
    dateOfBirth: string().optional(),
    gender: string().optional(),
    payer: object({
      name: string(),
      payerId: string().optional(),
    }).optional(),
  }),
  claims: array(Claim837Schema),
  subscribers: array(zodAny()).optional(),
  claimCount: number().optional(),
  totalClaimAmount: number().optional(),
});
export type Claim837Transaction = z.infer<typeof Claim837TransactionSchema>;

// 835 Remittance Advice Schemas
export const Adjustment835Schema = object({
  groupCode: string(), // CO (Contractual Obligations), PR (Patient Responsibility), etc.
  reasonCode: string(),
  amount: number(),
  quantity: number().optional(),
});
export type Adjustment835 = z.infer<typeof Adjustment835Schema>;

export const ServicePayment835Schema = object({
  procedureCode: string(),
  chargeAmount: number(),
  paidAmount: number(),
  unitsPaid: number().optional(),
  serviceDate: string().optional(),
  adjustments: array(Adjustment835Schema).default([]),
});
export type ServicePayment835 = z.infer<typeof ServicePayment835Schema>;

export const ClaimPayment835Schema = object({
  patientControlNumber: string(),
  claimStatusCode: string(),
  totalCharge: number(),
  totalPaid: number(),
  patientResponsibility: number().default(0),
  payerClaimControlNumber: string().optional(),
  patient: object({
    name: string(),
    memberId: string().optional(),
  }),
  adjustments: array(Adjustment835Schema).default([]),
  services: array(ServicePayment835Schema).default([]),
});
export type ClaimPayment835 = z.infer<typeof ClaimPayment835Schema>;

export const Remittance835TransactionSchema = object({
  transactionType: literal('835'),
  controlNumber: string(),
  paymentInfo: object({
    totalAmount: number(),
    paymentMethod: string(), // ACH, CHK, NON, etc.
    paymentDate: string(),
    checkOrEftTraceNumber: string().optional(),
  }),
  payer: object({
    name: string(),
    id: string().optional(),
    address: object({
      street: string().optional(),
      city: string().optional(),
      state: string().optional(),
      zip: string().optional(),
    }).optional(),
  }),
  payee: object({
    name: string(),
    npi: string().optional(),
    taxId: string().optional(),
  }),
  claimPayments: array(ClaimPayment835Schema),
});
export type Remittance835Transaction = z.infer<typeof Remittance835TransactionSchema>;

// 270 / 271 Eligibility Schemas
export const BenefitItem271Schema = object({
  eligibilityCode: string(), // 1 = Active, 6 = Inactive, etc.
  eligibilityDescription: string(),
  serviceTypeCode: string().optional(), // 30 = Health Benefit Plan, 35 = Dental, etc.
  serviceTypeDescription: string().optional(),
  coverageLevel: string().optional(), // IND, FAM
  copayAmount: number().optional(),
  coinsurancePercent: number().optional(),
  deductibleAmount: number().optional(),
  outOfPocketMax: number().optional(),
});
export type BenefitItem271 = z.infer<typeof BenefitItem271Schema>;

export const Eligibility271TransactionSchema = object({
  transactionType: literal('271'),
  controlNumber: string(),
  informationSource: object({
    name: string(),
    id: string().optional(),
  }),
  informationReceiver: object({
    name: string(),
    id: string().optional(),
  }),
  subscriber: object({
    memberId: string(),
    name: string(),
    dateOfBirth: string().optional(),
    gender: string().optional(),
    planNumber: string().optional(),
  }),
  benefits: array(BenefitItem271Schema),
});
export type Eligibility271Transaction = z.infer<typeof Eligibility271TransactionSchema>;

export * from './snip.js';
export * from './hipaa.js';
import { SnipValidationResultSchema } from './snip.js';

// Generic / Envelope Output Schemas
export const X12ParseResultSchema = object({
  valid: boolean(),
  delimiters: DelimitersSchema,
  interchange: InterchangeEnvelopeSchema,
  functionalGroups: array(FunctionalGroupSchema),
  totalTransactions: number(),
  transactions: array(union([
    Claim837TransactionSchema,
    Remittance835TransactionSchema,
    Eligibility271TransactionSchema,
    object({
      transactionType: string(),
      controlNumber: string(),
      segmentCount: number(),
      segments: array(SegmentSchema),
    }),
  ])),
  snipValidation: object({
    level: number(),
    passed: boolean(),
    errors: array(string()),
  }).optional(),
  errors: array(string()).default([]),
});
export type X12ParseResult = z.infer<typeof X12ParseResultSchema>;

export const X12ValidateResultSchema = object({
  valid: boolean(),
  delimiters: DelimitersSchema.nullable(),
  summary: object({
    hasInterchangeHeader: boolean(),
    hasInterchangeTrailer: boolean(),
    hasFunctionalGroupHeader: boolean(),
    hasFunctionalGroupTrailer: boolean(),
    interchangeControlNumberMatches: boolean(),
    groupControlNumberMatches: boolean(),
    transactionCount: number(),
    segmentCount: number(),
  }),
  snipValidation: SnipValidationResultSchema.optional(),
  errors: array(string()),
});
export type X12ValidateResult = z.infer<typeof X12ValidateResultSchema>;

