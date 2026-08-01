# Local-file sharing — design note (NOT implemented)

Status: **design direction only.** No storage, uploads, or credentials are wired
up. This documents the intended production path so the current honest behavior
(each viewer opens their own copy; only playheads sync) can later be replaced.

## Why the current model can't share a file

A browser-local file is exposed to the page as an `blob:`/object URL created with
`URL.createObjectURL`. That URL is scoped to the origin **and the tab** that
created it — it is meaningless to any other machine or even another tab. There is
no way for the host's browser to hand a peer bytes that live only on the host's
disk. Sharing a local file therefore *requires* uploading it somewhere both
clients can fetch. This is a platform boundary, not a bug. The UI must never
imply otherwise (the source picker and the partner prompt both say the peer needs
their own copy).

## Target production pipeline (future phase, needs approval + credentials)

1. Host selects a local file.
2. Client requests a **signed upload URL** from the server (`POST /media/uploads`).
3. Browser uploads directly to object storage (S3 / Cloudflare R2 / Supabase
   Storage) with a progress bar and a hard size cap.
4. Server validates declared MIME type + size, records an expiry.
5. Server returns a shared media URL; room source becomes
   `{ type: 'url' | 'localHosted', value: sharedUrl }`.
6. Everyone streams the same hosted origin — sync works exactly like any URL.
7. Objects expire automatically (e.g. TTL / lifecycle rule) so nothing lingers.
8. Later: HLS/transcoding (Mux, Cloudflare Stream) for adaptive playback.

## Minimal seam to add first (cheap, no vendor lock-in)

Introduce a `MediaStore` interface:

```ts
interface MediaStore {
  createUpload(meta: { name: string; size: number; mime: string }):
    Promise<{ uploadUrl: string; mediaUrl: string; expiresAt: number }>;
}
```

Ship a dev/no-op implementation that rejects with "hosted uploads not configured"
so the UI can render the flow behind a feature flag without any paid service. A
real implementation (signed URLs) is dropped in when storage is provisioned.

## Guardrails (carry into implementation)

- Never send video bytes through Socket.IO room messages or base64 broadcasts.
- Enforce size + MIME validation server-side, not just client-side.
- Expiring URLs; no permanent public buckets.
- No YouTube downloading/proxying/caching — YouTube stays embed-only.
