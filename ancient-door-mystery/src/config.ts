import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional().default(""),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  console.error("Invalid environment:\n" + details);
  process.exit(1);
}

const allowed = new Set(
  parsed.data.TELEGRAM_ALLOWED_CHAT_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

export const config = {
  telegramToken: parsed.data.TELEGRAM_BOT_TOKEN,
  allowedChatIds: allowed,
};
