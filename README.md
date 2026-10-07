# Tanvo for JavaScript and TypeScript

[![npm](https://img.shields.io/npm/v/tanvo)](https://www.npmjs.com/package/tanvo) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

The JavaScript / TypeScript client for [Tanvo](https://tanvo.ai/?utm_source=github&utm_medium=referral), an AI image, video and music studio. Generate images on Nano Banana, Seedream, GPT Image and Qwen, video on Veo, Kling, Seedance and Wan, and songs on Suno, or run one of 80 ready-made photo apps (pet portraits, figurines, old photo restoration, trend videos) on your own photos.

- Zero dependencies, typed. Node 20+, Deno, Bun, Cloudflare Workers, Vercel Edge and browsers.
- **Works without an API key** on the free tier (house image engine, watermarked).
- Local files and bytes are uploaded for you; results download with one call (Node, Deno, Bun).
- Retries that never double-charge (every submit carries an idempotency key).

```bash
npm install tanvo
```

## Quick start

```ts
import { Tanvo } from "tanvo";

const tanvo = new Tanvo(); // reads TANVO_API_KEY; without one it runs on the free tier
const image = await tanvo.generateImage({ prompt: "a paper lantern floating over a misty lake at dawn", aspect: "16:9" });
console.log(image.outputs[0].url);
await tanvo.download(image, "out/");
```

Create a key under [Settings → API keys](https://tanvo.ai/settings/apikeys?utm_source=github&utm_medium=referral) to use every model, get clean output and have runs land in your history. Keep keys on the server; in the browser, use the free tier or proxy through your backend.

```ts
const tanvo = new Tanvo({ apiKey: process.env.TANVO_API_KEY });
```

## Ready-made apps

Each app has preset looks: a tuned prompt, model and settings with a real example output.

```ts
for (const app of (await tanvo.apps("image")).slice(0, 5)) console.log(app.slug, app.looks.map((l) => l.id));

const portrait = await tanvo.generateFromApp({
  app: "ai-pet-portrait-generator",
  look: "royal",
  photos: ["rex.jpg"], // local path, https URL, bytes or a Blob, in the order of app.inputs
  details: "Rex, a very good boy",
});
```

## Images

```ts
// Any model: see await tanvo.models("image") for ids, options and prices
await tanvo.generateImage({ prompt: "isometric cutaway of a tiny ramen shop", model: "nano-banana-2", resolution: "2K" });

// Edit or combine photos: say what to change and what to keep
await tanvo.generateImage({
  prompt: "change the jacket to dark green; keep the face, pose and background exactly as they are",
  model: "nano-banana-2",
  images: ["portrait.jpg"],
});
```

## Video

Video takes one to several minutes, so `generateVideo` returns at once by default.

```ts
const job = await tanvo.generateVideo({ prompt: "slow dolly-in on a lighthouse in a storm", model: "kling-3-0", resolution: "720p", duration: 5 });
const clip = await tanvo.wait(job.id); // or pass wait: true
await tanvo.download(clip, "out/");

await tanvo.generateVideo({ prompt: "the cat turns its head and blinks", model: "seedance-2-5", image: "cat.jpg", wait: true });
```

## Songs

Two takes per run, each an MP3 with cover art, a title and the lyrics as sung.

```ts
const song = await tanvo.generateMusic({
  prompt: "an upbeat birthday song for my sister Ana: surfing, terrible puns, a big singalong chorus",
  style: "acoustic pop, hand claps, warm female vocal",
});
for (const take of song.outputs) console.log(take.title, take.seconds, take.url, take.cover);

await tanvo.generateMusic({ prompt: "[Verse]\n…\n[Chorus]\n…", mode: "Lyrics", title: "Ana Rides Again", vocal: "f" });
await tanvo.generateMusic({ prompt: "mellow lo-fi study beat, vinyl crackle, 75 bpm", mode: "Instrumental" });
```

## Runs and webhooks

```ts
const g = await tanvo.get("cm…");
const { generations, nextBefore } = await tanvo.list({ limit: 20 });

// Skip polling: the finished run is POSTed to you
await tanvo.generateVideo({ prompt: "…", model: "veo-3-1", webhookUrl: "https://example.com/api/tanvo" });
```

Verify the delivery with the secret from Settings → Webhooks (works on Node, Edge and Workers):

```ts
import { verifyWebhook } from "tanvo";

export async function POST(req: Request) {
  const generation = await verifyWebhook(process.env.TANVO_WEBHOOK_SECRET!, req.headers, await req.text());
  return new Response(null, { status: 204 });
}
```

Webhooks can arrive more than once; de-duplicate on the `webhook-id` header.

## Errors

| Class | When | What to do |
|---|---|---|
| `InvalidRequestError` | Bad option, refused prompt, file too large | Fix the input |
| `AuthError` | Missing or invalid key | Check the key |
| `QuotaError` | Out of credits, free tier limit, `busy` | Top up, add a key, or wait (`waitForSlot: true` waits for a free slot) |
| `ServiceError` | Upstream model or network failure | Already retried twice with the same request key; try again later |

All extend `TanvoError` with `code` (stable string), `status` and `issues`. Failed runs are refunded automatically.

## Settings

| | |
|---|---|
| `TANVO_API_KEY` | API key (or `new Tanvo({ apiKey })`) |
| `TANVO_BASE_URL` | Another deployment (default `https://tanvo.ai`) |

## Also from Tanvo

- [tanvo-mcp](https://github.com/tanvoai/tanvo-mcp): the same apps and models inside Claude, Cursor and other MCP clients.
- [tanvo-python](https://github.com/tanvoai/tanvo-python): the Python client.

## License

MIT
