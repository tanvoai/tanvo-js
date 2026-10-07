import { WebhookVerificationError } from "./errors.js";
import type { Generation } from "./types.js";

type Headers = Record<string, string | string[] | undefined> | { get(name: string): string | null };

function header(h: Headers, name: string): string | undefined {
  if (typeof (h as { get?: unknown }).get === "function") return (h as { get(n: string): string | null }).get(name) ?? undefined;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks a completion webhook (Standard Webhooks) and returns the Generation it carries. Pass the raw request body
 * exactly as received (string or bytes), not re-serialised JSON. Throws WebhookVerificationError on a bad signature or
 * a timestamp more than `toleranceSeconds` away. The same `webhook-id` can arrive more than once: de-duplicate on it.
 * Works in Node 18+, Deno, Bun, Cloudflare Workers and Vercel Edge (Web Crypto).
 */
export async function verifyWebhook(secret: string, headers: Headers, body: string | Uint8Array, toleranceSeconds = 300): Promise<Generation> {
  const id = header(headers, "webhook-id");
  const ts = header(headers, "webhook-timestamp");
  const sig = header(headers, "webhook-signature");
  if (!id || !ts || !sig) throw new WebhookVerificationError("missing_headers", "webhook-id, webhook-timestamp and webhook-signature are required.");
  const sent = Number(ts);
  if (!Number.isFinite(sent)) throw new WebhookVerificationError("bad_timestamp", "webhook-timestamp is not a number.");
  if (Math.abs(Date.now() / 1000 - sent) > toleranceSeconds) throw new WebhookVerificationError("stale", `The webhook timestamp is more than ${toleranceSeconds} s from now.`);
  const raw = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const key = await crypto.subtle.importKey("raw", fromB64(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${id}.${ts}.`);
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix);
  signed.set(raw, prefix.length);
  const expected = b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)));
  const ok = sig.split(" ").some((part) => part.startsWith("v1,") && same(part.slice(3), expected));
  if (!ok) throw new WebhookVerificationError("bad_signature", "The webhook signature does not match. Check the secret under Settings → Webhooks.");
  return JSON.parse(new TextDecoder().decode(raw)) as Generation;
}
