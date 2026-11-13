import type { Spark, SparkImage, SparkInput, SparkPage } from "../shared/types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  list(opts: { q?: string; cursor?: string | null }, signal?: AbortSignal) {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.cursor) params.set("cursor", opts.cursor);
    return request<SparkPage>(`/api/sparks?${params}`, { signal });
  },
  create: (input: SparkInput) => request<Spark>("/api/sparks", json("POST", input)),
  update: (id: number, input: SparkInput) => request<Spark>(`/api/sparks/${id}`, json("PUT", input)),
  remove: (id: number) => request<void>(`/api/sparks/${id}`, { method: "DELETE" }),
  uploadImage(file: Blob) {
    const form = new FormData();
    form.append("file", file, (file as File).name || "pasted-image");
    return request<SparkImage>("/api/images", { method: "POST", body: form });
  },
};
