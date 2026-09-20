import { array, boolean, enum as zodEnum, number, object, record, string, type z } from 'zod';

export const HipaaIdentifierTypeSchema = zodEnum([
  'NAME',
  'GEOGRAPHY',
  'DATE',
  'PHONE',
  'FAX',
  'EMAIL',
  'SSN',
  'MRN',
  'MEMBER_ID',
  'ACCOUNT',
  'CERTIFICATE_LICENSE',
  'VEHICLE',
  'DEVICE',
  'URL',
  'IP',
  'BIOMETRIC',
  'PHOTO',
  'NPI',
]);
export type HipaaIdentifierType = z.infer<typeof HipaaIdentifierTypeSchema>;

export const DetectedEntitySchema = object({
  type: HipaaIdentifierTypeSchema,
  surrogateToken: string(),
  originalValue: string().optional(),
  start: number().optional(),
  end: number().optional(),
});
export type DetectedEntity = z.infer<typeof DetectedEntitySchema>;

export const HipaaRedactRequestSchema = object({
  unstructuredText: string().optional(),
  rawEdi: string().optional(),
  tokenizeForLlm: boolean().optional().default(true),
  safeHarborIdentifiers: array(HipaaIdentifierTypeSchema).optional(),
  surrogateSalt: string().optional(),
  secretKey: string().optional(),
});
export type HipaaRedactRequest = z.input<typeof HipaaRedactRequestSchema>;

export const HipaaRedactResponseDataSchema = object({
  safeText: string().optional(),
  safeEdi: string().optional(),
  phiIdentifiersScrubbed: number(),
  detectedEntities: array(DetectedEntitySchema),
  tokenMap: record(string(), string()).optional(),
  rehydrationMode: zodEnum(['token_map', 'encrypted_token', 'masked']),
});
export type HipaaRedactResponseData = z.infer<typeof HipaaRedactResponseDataSchema>;

export const HipaaRehydrateRequestSchema = object({
  redactedText: string().optional(),
  redactedEdi: string().optional(),
  tokenMap: record(string(), string()).optional(),
  secretKey: string().optional(),
});
export type HipaaRehydrateRequest = z.input<typeof HipaaRehydrateRequestSchema>;

export const HipaaRehydrateResponseDataSchema = object({
  rehydratedText: string().optional(),
  rehydratedEdi: string().optional(),
  tokensReplaced: number(),
});
export type HipaaRehydrateResponseData = z.infer<typeof HipaaRehydrateResponseDataSchema>;
