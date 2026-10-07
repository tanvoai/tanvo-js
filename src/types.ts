export type Kind = "image" | "video" | "music";
export type Status = "QUEUED" | "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELED";

export interface Output {
  url: string;
  mime: string;
  /** Songs only. */
  cover?: string;
  title?: string;
  lyrics?: string;
  seconds?: number;
}

export interface Generation {
  id: string;
  kind: Kind;
  model: string;
  prompt: string;
  options: Record<string, unknown>;
  /** Credits charged; refunded automatically if the run fails. */
  cost: number;
  status: Status;
  error: string | null;
  /** Milliseconds since the epoch. */
  createdAt: number;
  outputs: Output[];
}

export interface Model {
  id: string;
  kind: Kind;
  name: string;
  vendor?: string;
  description?: string;
  free_tier: boolean;
  inputs: string[];
  options: Record<string, unknown>;
  defaults: Record<string, unknown>;
  credits_at_defaults: number;
  prompt_max_chars: number;
  reference_images_max?: number;
  [key: string]: unknown;
}

export interface Look {
  id: string;
  name: string;
  prompt: string;
  model: string;
  options: Record<string, unknown>;
  example: { url: string; kind: string; video?: string } | null;
  /** Opens the app on this look in the browser. */
  url: string;
}

export interface App {
  slug: string;
  kind: Kind;
  name: string;
  description: string;
  category: string | null;
  tags: string[];
  model: string;
  models: string[];
  spec: string;
  url: string;
  example: { url: string; kind: string } | null;
  inputs: Array<{ id: string; label: string; hint: string; accept: string; min: number; max: number }>;
  looks: Look[];
}

export interface Account {
  tier: "paid" | "free" | "anonymous";
  email?: string;
  credits: number;
  watermarked: boolean;
  concurrency: number;
}

/** A photo or file: a public https URL, a local path (Node, Deno, Bun), or the bytes themselves. */
export type FileInput = string | Uint8Array | ArrayBuffer | Blob;

export const isDone = (g: Pick<Generation, "status">) => g.status === "SUCCEEDED" || g.status === "FAILED" || g.status === "CANCELED";
