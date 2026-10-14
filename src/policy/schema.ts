import { z } from 'zod';

const list = z
  .union([z.string(), z.array(z.string()).min(1)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const MatchSchema = z
  .object({
    tool: list.optional(),
    command: list.optional(),
    args: z
      .object({ any: list.optional(), all: list.optional(), none: list.optional() })
      .strict()
      .optional(),
    path: list.optional(),
    reads: list.optional(),
    writes: list.optional(),
    domain: list.optional(),
    codeFrom: list.optional(),
    secrets: z.boolean().optional(),
    dynamic: z.boolean().optional(),
    unresolved: z.boolean().optional(),
    inlineCode: z.boolean().optional(),
    parseError: z.boolean().optional(),
    remote: z.boolean().optional(),
  })
  .strict();

export const RuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes'),
    match: MatchSchema,
    decision: z.enum(['allow', 'ask', 'deny']),
    reason: z.string().optional(),
    final: z.boolean().optional(),
  })
  .strict();

const duration = z.union([
  z.number().positive(),
  z.string().regex(/^\d+(ms|s|m)$/, 'use a number of seconds or a value like 90s or 2m'),
]);

export const PolicySchema = z
  .object({
    version: z.literal(1),
    name: z.string().optional(),
    description: z.string().optional(),
    extends: z.string().optional(),
    default: z.enum(['pass', 'ask', 'allow']).optional(),
    rules: z.array(RuleSchema).default([]),
    disable: z.array(z.string()).default([]),
    approval: z
      .object({
        timeout: duration.optional(),
        onTimeout: z.enum(['deny', 'allow']).optional(),
        channels: z.array(z.enum(['native', 'tty', 'web'])).optional(),
        notify: z.boolean().optional(),
        port: z.number().int().min(1024).max(65535).optional(),
      })
      .strict()
      .optional(),
    failMode: z.enum(['closed', 'open']).optional(),
    snapshots: z
      .object({
        enabled: z.boolean().optional(),
        maxFileSize: z
          .union([
            z.number().positive(),
            z.string().regex(/^\d+(KB|MB|GB)$/i, 'use a size like 20MB'),
          ])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Match = z.infer<typeof MatchSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type PolicyFile = z.infer<typeof PolicySchema>;

/** Turns zod issues into short lines a person can act on. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const where = i.path.length > 0 ? i.path.join('.') : '(top level)';
      return `${where}: ${i.message}`;
    })
    .join('\n');
}
