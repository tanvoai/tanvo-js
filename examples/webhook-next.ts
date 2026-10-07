// app/api/tanvo/route.ts in a Next.js app: receive finished runs instead of polling.
import { verifyWebhook } from "tanvo";

export async function POST(req: Request) {
  const raw = await req.text(); // the raw body: do not parse before verifying
  const generation = await verifyWebhook(process.env.TANVO_WEBHOOK_SECRET!, req.headers, raw);
  // De-duplicate on req.headers.get("webhook-id"), then store generation.outputs …
  console.log(generation.id, generation.status, generation.outputs.map((o) => o.url));
  return new Response(null, { status: 204 });
}
