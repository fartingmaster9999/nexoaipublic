import { createHash } from "node:crypto";

/** Opaque, in-memory cache partitioning for provider accounts; never log or persist this value. */
export function providerKeyScope(provider: "groq" | "gemini", apiKey: string): string {
  return `${provider}:${createHash("sha256").update(apiKey).digest("hex")}`;
}
