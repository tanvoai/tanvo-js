import { ServiceError, TanvoError, errorFor } from "./errors.js";
import { isDone, type Account, type App, type FileInput, type Generation, type Kind, type Look, type Model } from "./types.js";
import { verifyWebhook } from "./webhook.js";

export * from "./errors.js";
export * from "./types.js";
export { verifyWebhook };

export const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://tanvo.ai";

const env = (name: string): string | undefined => (typeof process !== "undefined" ? process.env?.[name] : undefined) || undefined;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4" };

export interface ClientOptions {
  /** Defaults to TANVO_API_KEY. Without a key the client runs on the anonymous free tier (house image engine only). */
  apiKey?: string;
  /** Free-tier wallet id; one is made per client when omitted. */
  anonId?: string;
  /** Defaults to TANVO_BASE_URL, then https://tanvo.ai. */
  baseUrl?: string;
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number;
  /** A custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /** @internal Replaces the delays used by polling and retries (tests). */
  sleep?: (ms: number) => Promise<void>;
}

interface Common {
  /** Wait for the result. */
  wait?: boolean;
  /** How long `wait` may take before returning the run as it stands (still running). */
  timeoutMs?: number;
  /** Idempotency key: a repeat with the same key returns the first run and is not charged again. Made for you if omitted. */
  requestKey?: string;
  /** POST the finished run here instead of polling (https only). */
  webhookUrl?: string;
  /** When the account is at its concurrency limit, wait for a free slot instead of throwing `busy`. */
  waitForSlot?: boolean;
}
export interface ImageParams extends Common {
  prompt: string;
  /** Model id from `models("image")`. Default: the free house engine. */
  model?: string;
  aspect?: string;
  resolution?: string;
  format?: "PNG" | "JPG" | "WEBP";
  /** Photos to edit or combine. */
  images?: FileInput[];
  negativePrompt?: string;
}
export interface VideoParams extends Common {
  prompt: string;
  model?: string;
  aspect?: string;
  resolution?: string;
  duration?: number;
  audio?: boolean;
  /** Start frame for image to video. */
  image?: FileInput;
  /** End frame, on models that support it. */
  endImage?: FileInput;
  negativePrompt?: string;
}
export interface MusicParams extends Common {
  /** Describe: one sentence about the song. Lyrics: your lyrics with [Verse] / [Chorus] tags. Instrumental: the sound you want. */
  prompt: string;
  mode?: "Describe" | "Lyrics" | "Instrumental";
  style?: string;
  title?: string;
  vocal?: "m" | "f";
  model?: string;
}
export interface AppParams extends Common {
  /** App slug from `apps()`, e.g. "ai-pet-portrait-generator". */
  app: string;
  /** Look id; defaults to the app's first look. */
  look?: string;
  /** Photos in the order of the app's inputs. */
  photos?: FileInput[];
  /** A personal touch woven into the prompt, e.g. "for my sister Ana". */
  details?: string;
}

export class Tanvo {
  readonly apiKey?: string;
  readonly anonId?: string;
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private modelsCache?: Promise<Model[]>;
  private appsCache?: Promise<App[]>;

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey ?? env("TANVO_API_KEY");
    this.anonId = this.apiKey ? undefined : (options.anonId ?? `js-${crypto.randomUUID()}`);
    this.baseUrl = (options.baseUrl ?? env("TANVO_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, retries = 0): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    else headers["x-anon-id"] = this.anonId!;
    if (typeof window === "undefined") headers["user-agent"] = `tanvo-js/${VERSION}`;
    let attempt = 0;
    let rateLimited = false;
    for (;;) {
      let err: TanvoError;
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
        const text = await res.text();
        let data: Record<string, any> = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          if (res.ok) throw new ServiceError("bad_response", `Unreadable response from ${this.baseUrl}.`, res.status);
        }
        if (res.ok) return data as T;
        const retry = res.headers.get("retry-after");
        err = errorFor(data.error ?? `http_${res.status}`, data.message ?? `HTTP ${res.status}`, res.status, data.issues ?? [], retry && /^\d+$/.test(retry) ? Number(retry) : undefined, !!this.apiKey);
      } catch (e) {
        if (e instanceof TanvoError) throw e;
        err = new ServiceError("network", `Could not reach ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (err.code === "rate_limited" && !rateLimited) {
        rateLimited = true;
        await this.sleep(Math.min(err.retryAfter ?? 5, 60) * 1000);
        continue;
      }
      if (err instanceof ServiceError && attempt < retries) {
        await this.sleep([1000, 3000][Math.min(attempt, 1)]);
        attempt++;
        continue;
      }
      throw err;
    }
  }

  // ─── Catalogue and account ─────────────────────────────────────────────

  /** Every model with its options, defaults and credit cost at defaults (cached on the client). */
  async models(kind?: Kind): Promise<Model[]> {
    this.modelsCache ??= this.request<{ models: Model[] }>("GET", "/models", undefined, 2).then((r) => r.models).catch((e) => {
      this.modelsCache = undefined;
      throw e;
    });
    return (await this.modelsCache).filter((m) => !kind || m.kind === kind);
  }
  async model(id: string): Promise<Model> {
    const m = (await this.models()).find((x) => x.id === id);
    if (!m) throw new Error(`Unknown model "${id}". See models().`);
    return m;
  }
  /** Ready-made apps (pet portraits, figurines, trend videos, songs…) with their preset looks (cached on the client). */
  async apps(kind?: Kind): Promise<App[]> {
    this.appsCache ??= this.request<{ apps: App[] }>("GET", "/apps", undefined, 2).then((r) => r.apps).catch((e) => {
      this.appsCache = undefined;
      throw e;
    });
    return (await this.appsCache).filter((a) => !kind || a.kind === kind);
  }
  async app(slug: string): Promise<App> {
    const a = (await this.apps()).find((x) => x.slug === slug);
    if (!a) throw new Error(`Unknown app "${slug}". See apps().`);
    return a;
  }
  me(): Promise<Account> {
    return this.request<Account>("GET", "/me", undefined, 2);
  }

  // ─── Generation ────────────────────────────────────────────────────────

  private async options(modelId: string, given: Record<string, unknown>) {
    const defaults = (await this.models()).find((m) => m.id === modelId)?.defaults ?? {};
    return { ...defaults, ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) };
  }

  private async submit(body: Record<string, unknown>, c: Common, defaults: { wait: boolean; timeoutMs: number }): Promise<Generation> {
    const clean = Object.fromEntries(Object.entries({ ...body, requestKey: c.requestKey ?? crypto.randomUUID(), webhookUrl: c.webhookUrl }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
    const timeoutMs = c.timeoutMs ?? defaults.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    let g: Generation;
    for (;;) {
      try {
        g = (await this.request<{ generation: Generation }>("POST", "/generations", clean, 2)).generation;
        break;
      } catch (e) {
        if (e instanceof TanvoError && e.code === "busy" && c.waitForSlot && Date.now() + 5000 < deadline) {
          await this.sleep(5000);
          continue;
        }
        throw e;
      }
    }
    return (c.wait ?? defaults.wait) ? this.wait(g.id, { timeoutMs: Math.max(1000, deadline - Date.now()), everyMs: g.kind === "video" ? 6000 : 4000 }) : g;
  }

  /** Text to image, or an edit / combination when `images` are given. Waits for the image by default. */
  async generateImage(p: ImageParams): Promise<Generation> {
    const model = p.model ?? "studio-image-v1";
    return this.submit(
      { kind: "image", model, prompt: p.prompt, negativePrompt: p.negativePrompt, options: await this.options(model, { aspect: p.aspect, resolution: p.resolution, format: p.format }), imageUrls: await Promise.all((p.images ?? []).map((f) => this.ref(f))) },
      p,
      { wait: true, timeoutMs: 180_000 },
    );
  }

  /** Text to video, or image to video from `image`. Returns at once by default; use `wait()` or `wait: true`. */
  async generateVideo(p: VideoParams): Promise<Generation> {
    const model = p.model ?? "studio-video-v1";
    return this.submit(
      {
        kind: "video", model, prompt: p.prompt, negativePrompt: p.negativePrompt,
        options: await this.options(model, { aspect: p.aspect, resolution: p.resolution, duration: p.duration, audio: p.audio }),
        imageUrls: p.image === undefined ? [] : [await this.ref(p.image)],
        endImageUrl: p.endImage === undefined ? undefined : await this.ref(p.endImage),
      },
      p,
      { wait: false, timeoutMs: 600_000 },
    );
  }

  /** Two takes of a song, each an MP3 with cover art, a title and the lyrics. Waits by default. */
  async generateMusic(p: MusicParams): Promise<Generation> {
    const options = Object.fromEntries(Object.entries({ tier: p.mode ?? "Describe", resolution: "song", style: p.style, title: p.title, vocal: p.vocal }).filter(([, v]) => v !== undefined));
    return this.submit({ kind: "music", model: p.model ?? "suno-v6", prompt: p.prompt, options }, p, { wait: true, timeoutMs: 300_000 });
  }

  /** Runs one of an app's preset looks on your photos: `generateFromApp({ app: "ai-pet-portrait-generator", look: "royal", photos: ["rex.jpg"] })`. */
  async generateFromApp(p: AppParams): Promise<Generation> {
    const app = await this.app(p.app);
    const look: Look | undefined = p.look ? app.looks.find((l) => l.id === p.look) : app.looks[0];
    if (!look) throw new Error(`"${app.name}" has no look "${p.look}". Looks: ${app.looks.map((l) => l.id).join(", ")}.`);
    const needed = app.inputs.filter((i) => i.min > 0);
    if ((p.photos?.length ?? 0) < needed.length) throw new Error(`${app.name} needs ${needed.length} photo(s): ${needed.map((i) => i.label).join(", ")}.`);
    const prompt = p.details ? `${look.prompt}\n\nThis one is for: ${p.details.trim()}.` : look.prompt;
    const imageUrls = app.kind === "music" ? [] : await Promise.all((p.photos ?? []).map((f) => this.ref(f)));
    return this.submit({ kind: app.kind, model: look.model, prompt, options: await this.options(look.model, look.options), imageUrls }, p, {
      wait: app.kind !== "video",
      timeoutMs: app.kind === "video" ? 600_000 : app.kind === "music" ? 300_000 : 180_000,
    });
  }

  // ─── Runs ──────────────────────────────────────────────────────────────

  async get(id: string): Promise<Generation> {
    return (await this.request<{ generation: Generation }>("GET", `/generations/${encodeURIComponent(id)}`, undefined, 2)).generation;
  }

  /** Polls until the run finishes. On timeout resolves with the last state seen (still running) instead of throwing. */
  async wait(id: string, o: { timeoutMs?: number; everyMs?: number } = {}): Promise<Generation> {
    const deadline = Date.now() + (o.timeoutMs ?? 600_000);
    const every = o.everyMs ?? 4000;
    await this.sleep(2000);
    let last: Generation | undefined;
    for (;;) {
      try {
        last = await this.get(id);
        if (isDone(last)) return last;
      } catch (e) {
        if (!(e instanceof ServiceError)) throw e; // one failed read is not a failed run
      }
      if (Date.now() + every > deadline) return last ?? this.get(id);
      await this.sleep(every);
    }
  }

  async list(o: { limit?: number; before?: number } = {}): Promise<{ generations: Generation[]; nextBefore: number | null }> {
    const q = new URLSearchParams(Object.entries({ limit: o.limit ?? 20, before: o.before }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    const r = await this.request<{ generations: Generation[]; next_before: number | null }>("GET", `/generations?${q}`, undefined, 2);
    return { generations: r.generations, nextBefore: r.next_before };
  }

  // ─── Files ─────────────────────────────────────────────────────────────

  /** Uploads a file (local path in Node / Deno / Bun, or bytes / a Blob) and returns a URL usable as a photo input. */
  async upload(file: FileInput, mime?: string): Promise<string> {
    let bytes: Uint8Array;
    if (typeof file === "string") {
      const { readFile } = await import("node:fs/promises");
      bytes = new Uint8Array(await readFile(file.replace(/^file:\/\//, "")));
      mime ??= MIME[file.split(".").pop()?.toLowerCase() ?? ""];
      if (!mime) throw new Error(`Cannot tell the file type of ${file}; pass a mime type.`);
    } else if (file instanceof Blob) {
      bytes = new Uint8Array(await file.arrayBuffer());
      mime ??= file.type || undefined;
    } else {
      bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
    }
    mime ??= sniff(bytes);
    const slot = await this.request<{ upload_url: string; url: string }>("POST", "/uploads", { mime, bytes: bytes.byteLength });
    const put = await this.fetchImpl(slot.upload_url, { method: "PUT", headers: { "content-type": mime }, body: bytes as unknown as BodyInit });
    if (!put.ok) throw new ServiceError("upload_failed", `Upload failed with HTTP ${put.status}.`, put.status);
    return slot.url;
  }

  private async ref(f: FileInput): Promise<string> {
    if (typeof f === "string" && /^https:\/\//i.test(f)) return f;
    if (typeof f === "string" && /^http:\/\//i.test(f) && !this.baseUrl.startsWith("http://")) throw new Error(`Only https URLs can be fetched by the service: ${f}`);
    return this.upload(f);
  }

  /** Node / Deno / Bun: saves one output to `path` (a folder ending in "/" or a file name) and returns the file path. */
  async download(generation: Generation | string, path = "./", index = 0): Promise<string> {
    const g = typeof generation === "string" ? await this.get(generation) : generation;
    const out = g.outputs[index];
    if (!out) throw new Error(`Generation ${g.id} has no output ${index} (status ${g.status}).`);
    const fs = await import("node:fs/promises");
    const res = await this.fetchImpl(out.url);
    if (!res.ok) throw new ServiceError("download_failed", `Download failed with HTTP ${res.status}.`, res.status);
    let target = path;
    const isDir = path.endsWith("/") || (await fs.stat(path).then((s) => s.isDirectory()).catch(() => false));
    if (isDir) {
      await fs.mkdir(path, { recursive: true });
      const ext = new URL(out.url).pathname.match(/\.[a-z0-9]+$/i)?.[0] ?? ".bin";
      target = `${path.replace(/\/?$/, "/")}tanvo-${g.id}-${index}${ext}`;
    }
    await fs.writeFile(target, new Uint8Array(await res.arrayBuffer()));
    return target;
  }

  static verifyWebhook = verifyWebhook;
}

function sniff(b: Uint8Array) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return "application/octet-stream";
}

/** Alias matching the other SDKs: `new Client()`. */
export { Tanvo as Client };
export default Tanvo;
