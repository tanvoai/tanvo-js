// Offline tests against a fake API server: npm test
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { AuthError, Client, InvalidRequestError, QuotaError, ServiceError, Tanvo, VERSION, WebhookVerificationError, verifyWebhook } from "../dist/index.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 48)]);
const MODELS = [
  { id: "studio-image-v1", kind: "image", name: "Tanvo Image v1", free_tier: true, inputs: ["text", "image"], options: {}, defaults: { aspect: "1:1", resolution: "1K", format: "PNG" }, credits_at_defaults: 5, prompt_max_chars: 2000 },
  { id: "seedream-4", kind: "image", name: "Seedream 4.0", free_tier: false, inputs: ["text", "image"], options: {}, defaults: { aspect: "1:1", resolution: "2K" }, credits_at_defaults: 10, prompt_max_chars: 5000 },
  { id: "studio-video-v1", kind: "video", name: "Tanvo Video v1", free_tier: true, inputs: ["text", "image"], options: {}, defaults: { aspect: "16:9", resolution: "480p", duration: 5 }, credits_at_defaults: 20, prompt_max_chars: 2000 },
];
const APPS = [{
  slug: "ai-pet-portrait-generator", kind: "image", name: "Pet Portrait Generator", description: "", category: "Pets", tags: [], model: "seedream-4", models: ["seedream-4"], spec: "", url: "https://tanvo.ai/image/ai-pet-portrait-generator", example: null,
  inputs: [{ id: "in1", label: "Pet photo", hint: "", accept: "image/*", min: 1, max: 1 }],
  looks: [
    { id: "renaissance", name: "Renaissance oil", prompt: "Paint the pet as a Renaissance oil portrait.", model: "seedream-4", options: {}, example: null, url: "" },
    { id: "royal", name: "Royal monarch", prompt: "Paint the pet as a monarch.", model: "seedream-4", options: { aspect: "3:4" }, example: null, url: "" },
  ],
}];

let state;
const reset = () => (state = { requests: [], runs: new Map(), byKey: new Map(), failNext: [], pollsUntilDone: 1, uploaded: [] });
reset();
let base;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw.toString() });
  const send = (status, payload, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(payload));
  };
  if (req.url.startsWith("/put/")) {
    state.uploaded.push({ mime: req.headers["content-type"], bytes: raw.length });
    return res.writeHead(200).end();
  }
  if (req.url.startsWith("/files/")) return res.writeHead(200).end(PNG);
  if (state.failNext.length) {
    const [status, error, headers] = state.failNext.shift();
    return send(status, { error, message: `injected ${error}` }, headers);
  }
  const auth = req.headers.authorization;
  if (auth && auth !== "Bearer sk_good") return send(401, { error: "invalid_api_key", message: "That API key is not valid." });
  const p = req.url.split("?")[0];
  if (req.method === "GET" && p === "/api/v1/models") return send(200, { models: MODELS });
  if (req.method === "GET" && p === "/api/v1/apps") return send(200, { apps: APPS });
  if (req.method === "GET" && p === "/api/v1/me") return send(200, { tier: auth ? "paid" : "anonymous", credits: auth ? 900 : 5, watermarked: !auth, concurrency: auth ? 3 : 1 });
  if (req.method === "POST" && p === "/api/v1/generations") {
    const b = JSON.parse(raw);
    if (!auth && b.model !== "studio-image-v1") return send(403, { error: "needs_api_key", message: "The free tier covers the house image engine only." });
    if (b.options.resolution === "8K") return send(400, { error: "invalid", message: "That model or setting is not available.", issues: ["options.resolution: 8K"] });
    if (state.byKey.has(b.requestKey)) return send(202, { generation: state.runs.get(state.byKey.get(b.requestKey)).g });
    const id = `gen${state.runs.size + 1}`;
    const g = { id, kind: b.kind, model: b.model, prompt: b.prompt, options: b.options, cost: 5, status: "PROCESSING", error: null, createdAt: 1790000000000 + state.runs.size, outputs: [] };
    state.runs.set(id, { g, polls: 0 });
    state.byKey.set(b.requestKey, id);
    return send(202, { generation: g });
  }
  if (req.method === "GET" && p.startsWith("/api/v1/generations/")) {
    const r = state.runs.get(p.split("/").pop());
    if (!r) return send(404, { error: "not_found", message: "No such generation." });
    if (++r.polls >= state.pollsUntilDone) r.g = { ...r.g, status: "SUCCEEDED", outputs: [{ url: `${base}/files/${r.g.id}/0.png`, mime: "image/png" }] };
    return send(200, { generation: r.g });
  }
  if (req.method === "GET" && p === "/api/v1/generations") {
    const gs = [...state.runs.values()].map((r) => r.g).sort((a, b) => b.createdAt - a.createdAt).slice(0, 2);
    return send(200, { generations: gs, next_before: gs.at(-1)?.createdAt ?? null });
  }
  if (req.method === "POST" && p === "/api/v1/uploads") return send(200, { upload_url: `${base}/put/${state.uploaded.length}`, url: `https://media.tanvo.ai/uploads/u/${state.uploaded.length}.png`, expires_in: 300 });
  send(404, { error: "not_found", message: req.url });
});

const client = (apiKey) => new Tanvo({ apiKey, baseUrl: base, sleep: async () => {} });
const posts = () => state.requests.filter((r) => r.method === "POST" && r.url === "/api/v1/generations");

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  delete process.env.TANVO_API_KEY;
});
after(() => server.close());
beforeEach(reset);

describe("client", () => {
  it("runs a free image without a key, filling in the model's defaults", async () => {
    const c = client();
    assert.equal((await c.me()).tier, "anonymous");
    const g = await c.generateImage({ prompt: "a cat" });
    assert.equal(g.status, "SUCCEEDED");
    assert.equal(g.cost, 5);
    const sent = JSON.parse(posts()[0].body);
    assert.deepEqual(sent.options, { aspect: "1:1", resolution: "1K", format: "PNG" });
    assert.ok(sent.requestKey);
    assert.match(posts()[0].headers["x-anon-id"], /^js-/);
    assert.match(posts()[0].headers["user-agent"], /^tanvo-js\//);
  });

  it("explains how to get a key when the free tier does not cover a model", async () => {
    await assert.rejects(client().generateVideo({ prompt: "a fox" }), (e) => e instanceof QuotaError && e.code === "needs_api_key" && /settings\/apikeys/.test(e.message));
  });

  it("lets given options override the model's defaults", async () => {
    await client("sk_good").generateImage({ prompt: "a cat", model: "seedream-4", aspect: "16:9" });
    assert.deepEqual(JSON.parse(posts()[0].body).options, { aspect: "16:9", resolution: "2K" });
    assert.equal(posts()[0].headers.authorization, "Bearer sk_good");
  });

  it("is idempotent on requestKey", async () => {
    const c = client("sk_good");
    const a = await c.generateImage({ prompt: "a cat", requestKey: "job-1", wait: false });
    const b = await c.generateImage({ prompt: "a cat", requestKey: "job-1", wait: false });
    assert.equal(a.id, b.id);
    assert.equal(state.runs.size, 1);
  });

  it("returns video at once, then waits on request", async () => {
    const c = client("sk_good");
    state.pollsUntilDone = 3;
    const g = await c.generateVideo({ prompt: "a fox in snow" });
    assert.equal(g.status, "PROCESSING");
    assert.equal((await c.wait(g.id)).status, "SUCCEEDED");
  });

  it("resolves with the last state when waiting times out", async () => {
    const c = client("sk_good");
    state.pollsUntilDone = 1e9;
    const g = await c.generateVideo({ prompt: "a fox" });
    assert.equal((await c.wait(g.id, { timeoutMs: 1, everyMs: 10 })).status, "PROCESSING");
  });

  it("maps errors to classes", async () => {
    await assert.rejects(client("sk_bad").me(), (e) => e instanceof AuthError && e.code === "invalid_api_key");
    await assert.rejects(client("sk_good").generateImage({ prompt: "x", resolution: "8K" }), (e) => e instanceof InvalidRequestError && e.issues[0] === "options.resolution: 8K");
  });

  it("retries service errors with the same request key, at most twice", async () => {
    const c = client("sk_good");
    await c.models();
    state.failNext = [[502, "provider"], [500, "server_error"]];
    assert.equal((await c.generateImage({ prompt: "a cat", wait: false })).status, "PROCESSING");
    assert.equal(new Set(posts().map((r) => JSON.parse(r.body).requestKey)).size, 1);
    assert.equal(posts().length, 3);
    state.failNext = [[502, "provider"], [502, "provider"], [502, "provider"]];
    await assert.rejects(c.generateImage({ prompt: "a dog", wait: false }), ServiceError);
  });

  it("waits once on rate limits and, when asked, for a free slot", async () => {
    const c = client("sk_good");
    await c.models();
    state.failNext = [[429, "rate_limited", { "retry-after": "2" }]];
    assert.equal((await c.me()).tier, "paid");
    state.failNext = [[409, "busy"]];
    await assert.rejects(c.generateImage({ prompt: "a cat", wait: false }), QuotaError);
    state.failNext = [[409, "busy"]];
    assert.equal((await c.generateImage({ prompt: "a cat", wait: false, waitForSlot: true })).status, "PROCESSING");
  });

  it("uploads local files and bytes, passes https URLs through", async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "tanvo-")), "a.png");
    await fs.writeFile(file, PNG);
    await client("sk_good").generateImage({ prompt: "make it winter", model: "seedream-4", images: [file, "https://example.com/a.jpg", new Uint8Array(PNG)], wait: false });
    const urls = JSON.parse(posts()[0].body).imageUrls;
    assert.equal(urls[1], "https://example.com/a.jpg");
    assert.ok(urls[0].startsWith("https://media.tanvo.ai/uploads/") && urls[2].startsWith("https://media.tanvo.ai/uploads/"));
    assert.deepEqual(state.uploaded.map((u) => u.mime), ["image/png", "image/png"]);
  });

  it("runs an app's look with the user's photos and details", async () => {
    const c = client("sk_good");
    await assert.rejects(c.generateFromApp({ app: "ai-pet-portrait-generator", look: "royal" }), /needs 1 photo/);
    await assert.rejects(c.generateFromApp({ app: "ai-pet-portrait-generator", look: "nope", photos: ["https://x/r.jpg"] }), /no look "nope"/);
    const g = await c.generateFromApp({ app: "ai-pet-portrait-generator", look: "royal", photos: ["https://example.com/rex.jpg"], details: "Rex" });
    assert.equal(g.status, "SUCCEEDED");
    const sent = JSON.parse(posts()[0].body);
    assert.equal(sent.model, "seedream-4");
    assert.deepEqual(sent.options, { aspect: "3:4", resolution: "2K" });
    assert.match(sent.prompt, /^Paint the pet as a monarch\.\n\nThis one is for: Rex\.$/);
  });

  it("lists, waits and downloads", async () => {
    const c = client("sk_good");
    for (const i of [1, 2, 3]) await c.generateImage({ prompt: `cat ${i}`, wait: false });
    const { generations, nextBefore } = await c.list({ limit: 2 });
    assert.equal(generations.length, 2);
    assert.equal(nextBefore, generations[1].createdAt);
    const dir = (await fs.mkdtemp(path.join(os.tmpdir(), "tanvo-"))) + "/";
    const file = await c.download(await c.wait(generations[0].id), dir);
    assert.deepEqual(await fs.readFile(file), PNG);
  });

  it("turns network failures into ServiceError", async () => {
    await assert.rejects(new Tanvo({ apiKey: "sk_good", baseUrl: "http://127.0.0.1:9", sleep: async () => {} }).me(), (e) => e instanceof ServiceError && e.code === "network");
  });

  it("exports Client as an alias and a version", () => {
    assert.equal(Client, Tanvo);
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  });
});

describe("verifyWebhook", () => {
  const key = Buffer.alloc(24, "k");
  const secret = `whsec_${key.toString("base64")}`;
  const body = JSON.stringify({ id: "gen1", kind: "image", model: "m", prompt: "p", options: {}, cost: 5, status: "SUCCEEDED", error: null, createdAt: 1, outputs: [] });
  const sign = (ts, b = body) => ({ "webhook-id": "msg_1", "webhook-timestamp": String(ts), "webhook-signature": `v1,${crypto.createHmac("sha256", key).update(`msg_1.${ts}.${b}`).digest("base64")}` });

  it("accepts a valid signature (plain object or Headers)", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await verifyWebhook(secret, sign(now), body)).id, "gen1");
    assert.equal((await Tanvo.verifyWebhook(secret, new Headers(sign(now)), new TextEncoder().encode(body))).id, "gen1");
  });
  it("rejects tampering, stale timestamps and missing headers", async () => {
    const now = Math.floor(Date.now() / 1000);
    await assert.rejects(verifyWebhook(secret, sign(now), body.replace("gen1", "gen2")), WebhookVerificationError);
    await assert.rejects(verifyWebhook(secret, sign(now - 600), body), WebhookVerificationError);
    await assert.rejects(verifyWebhook(secret, {}, body), WebhookVerificationError);
  });
});
