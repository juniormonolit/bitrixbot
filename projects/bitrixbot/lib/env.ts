import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  BITRIX_REST_BASE_URL: z.string().url(),
  BITRIX_PORTAL_URL: z.string().url(),
  BITRIX_APPLICATION_TOKEN: z.string().min(1),
  DEBUG_SECRET: z.string().min(1)
});

export type Env = z.infer<typeof envSchema>;

function formatZodError(error: z.ZodError) {
  const issues = error.issues.map((i) => {
    const path = i.path.join(".") || "(root)";
    return `${path}: ${i.message}`;
  });
  return issues.join("\n");
}

function parseEnv(): Env {
  const raw = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    BITRIX_REST_BASE_URL: process.env.BITRIX_REST_BASE_URL,
    BITRIX_PORTAL_URL: process.env.BITRIX_PORTAL_URL,
    BITRIX_APPLICATION_TOKEN: process.env.BITRIX_APPLICATION_TOKEN,
    DEBUG_SECRET: process.env.DEBUG_SECRET
  };

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment variables:\n${formatZodError(parsed.error)}`
    );
  }

  return parsed.data;
}

export const env = parseEnv();

export const envStatus = {
  supabaseConfigured: Boolean(env.NEXT_PUBLIC_SUPABASE_URL),
  bitrixRestConfigured: Boolean(env.BITRIX_REST_BASE_URL)
};

