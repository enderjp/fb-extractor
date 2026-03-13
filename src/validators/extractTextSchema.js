import { z } from "zod";

const optionsSchema = z
  .object({
    timeoutMs: z.number().int().min(3000).max(150000).optional(),
    locale: z.string().min(2).max(32).optional(),
  })
  .optional();

export const extractTextPayloadSchema = z.object({
  url: z
    .string()
    .url({ message: "You must supply a valid Facebook post URL." })
    .refine((value) => /facebook\.com|fb\.watch|fb\.com/.test(value), {
      message: "The URL must point to Facebook.",
    }),
  options: optionsSchema,
});
