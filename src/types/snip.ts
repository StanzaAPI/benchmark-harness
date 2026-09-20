import { array, boolean, literal, number, object, string, union, type z } from 'zod';

export const SnipLevelSchema = union([
  literal(1),
  literal(2),
  literal(3),
  literal(4),
]);
export type SnipLevel = z.infer<typeof SnipLevelSchema>;

export const SnipIssueSchema = object({
  level: SnipLevelSchema,
  code: string(),
  message: string(),
  segment: string().optional(),
  elementPosition: number().optional(),
  line: number().optional(),
});
export type SnipIssue = z.infer<typeof SnipIssueSchema>;

export const SnipLevelSummarySchema = object({
  passed: boolean(),
  errors: array(SnipIssueSchema),
});
export type SnipLevelSummary = z.infer<typeof SnipLevelSummarySchema>;

export const SnipValidationResultSchema = object({
  level: SnipLevelSchema,
  passed: boolean(),
  levels: object({
    level1: SnipLevelSummarySchema,
    level2: SnipLevelSummarySchema,
    level3: SnipLevelSummarySchema,
    level4: SnipLevelSummarySchema,
  }),
  errors: array(SnipIssueSchema),
});
export type SnipValidationResult = z.infer<typeof SnipValidationResultSchema>;
