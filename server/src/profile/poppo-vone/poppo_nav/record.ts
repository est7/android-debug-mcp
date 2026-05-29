import { z } from "zod";

export const PoppoNavRecordSchema = z
  .object({
    v: z.literal(1).optional(),
    tsMs: z.number().int(),
    type: z.string(),
    name: z.string(),
    host: z.string().optional(),
  })
  .passthrough();

export type PoppoNavRecord = z.output<typeof PoppoNavRecordSchema> & {
  readonly source: "poppo_nav";
};

export function parsePoppoNavLine(line: string): PoppoNavRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const result = PoppoNavRecordSchema.safeParse(raw);
  if (!result.success) return null;
  return { ...result.data, source: "poppo_nav" } as PoppoNavRecord;
}
