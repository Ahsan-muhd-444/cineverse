/**
 * S3-compatible storage adapter (AWS S3, Cloudflare R2, Supabase Storage,
 * MinIO — anything that speaks SigV4 presigned URLs).
 *
 * Single-shot presigning is implemented with node:crypto rather than the AWS
 * SDK. Note that constructing this adapter DOES load the AWS SDK: multipart
 * support is required eagerly from s3-multipart.js below, so the earlier claim
 * that the production path costs zero new dependencies is no longer true.
 *
 * The browser uploads DIRECTLY to the bucket with a presigned POST, so video
 * bytes never pass through (or buffer in) the Node process. Credentials stay
 * server-side: the browser only ever sees an opaque, expiring URL.
 *
 * Required env:
 *   S3_ENDPOINT           https://<account>.r2.cloudflarestorage.com
 *   S3_BUCKET             cineverse-uploads
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 * Optional:
 *   S3_REGION             default "auto" (R2) — use e.g. eu-west-1 for AWS
 *   S3_PUBLIC_BASE_URL    serve reads through a CDN/custom domain instead of
 *                         a presigned GET (bucket must then be public-read)
 *   UPLOAD_READ_TTL_SECONDS  default 21600 (6h) presigned GET lifetime
 */

const crypto = require('crypto');
const { describeS3Config, isS3Configured } = require('./s3-config');
const { HARD_LOCAL_UPLOAD_BYTES, validateSingleUploadGrant } = require('../upload-limits');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();

/** RFC3986 encoding — S3 requires the stricter form AWS calls "URI encode". */
function uriEncode(value, encodeSlash = true) {
  return String(value)
    .split('')
    .map((ch) => {
      if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
      if (ch === '/') return encodeSlash ? '%2F' : '/';
      return Array.from(Buffer.from(ch, 'utf8'))
        .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
        .join('');
    })
    .join('');
}

function amzDates(now) {
  const iso = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(secret, dateStamp, region) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

/**
 * Build a browser presigned POST — the ONLY upload shape that lets the bucket
 * itself reject an oversized body. A presigned PUT cannot: the size cap lives
 * only in our token, which S3 never sees. The POST policy pins the byte range,
 * the exact object key, and the Content-Type, so an approved client that lies
 * about its file size (or key/type) is rejected by S3 at upload time — Node
 * never has to see the bytes to enforce the limit.
 */
function buildPostPolicy(input, config, expiresIn, now = Date.now()) {
  /*
   * The COMPLETE grant is validated before anything is signed, using the same
   * validator as issuance, verification and completion.
   *
   * Checking only the byte fields here was a gap: a signed policy is a
   * capability, and this one could be minted for a malformed key, an
   * unsupported MIME, or a room that does not match the key it is signing.
   */
  const verdict = validateSingleUploadGrant(input);
  if (!verdict.ok) {
    throw new Error(`buildPostPolicy: invalid grant (${verdict.error})`);
  }
  const expectedBytes = input.expectedBytes;
  const maxBytes = input.maxBytes;

  const { amzDate, dateStamp } = amzDates(now);
  const credential = `${config.accessKeyId}/${dateStamp}/${config.region}/${SERVICE}/aws4_request`;
  const expiration = new Date(now + expiresIn * 1000).toISOString();

  const conditions = [
    { bucket: config.bucket },
    ['eq', '$key', input.key],
    ['eq', '$Content-Type', input.mimeType],
    /*
     * EXACT size, enforced by the bucket.
     *
     * This used to be `[1, maxBytes]`, and the handler passed the deployment's
     * `effectiveMaxBytes` as that maximum. With a 3 GiB deployment maximum, a
     * client declaring 100 MiB received a policy authorizing a 3 GiB body -
     * the selector protected the metadata while the actual grant stayed
     * deployment-wide. Pinning both ends to the declared size means S3 itself
     * rejects any body that is not the one that was authorized.
     */
    ['content-length-range', input.expectedBytes, input.expectedBytes],
    { 'x-amz-algorithm': ALGORITHM },
    { 'x-amz-credential': credential },
    { 'x-amz-date': amzDate },
  ];

  const policyB64 = Buffer.from(JSON.stringify({ expiration, conditions })).toString('base64');
  const signature = crypto
    .createHmac('sha256', signingKey(config.secretAccessKey, dateStamp, config.region))
    .update(policyB64)
    .digest('hex');

  const fields = {
    key: input.key,
    'Content-Type': input.mimeType,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    Policy: policyB64,
    'X-Amz-Signature': signature,
  };

  return { url: `${config.endpoint}/${config.bucket}`, fields, maxBytes: input.maxBytes };
}

/*
 * Configuration detection lives in s3-config.js and is shared with
 * validateConfig, createStorage and the runtime upload config. It used to be
 * duplicated here with different blankness rules: `Boolean(' ')` is true, so a
 * whitespace-only S3_BUCKET selected the S3 adapter while startup reported
 * local-fs.
 */
function readConfig(env = process.env) {
  const described = describeS3Config(env);
  if (described.config) return described.config;
  // Incomplete/invalid: return an inert shape so nothing half-built is usable.
  return { endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', region: 'auto', publicBaseUrl: '', readTtl: 21600 };
}

/**
 * Build a SigV4 presigned URL. Only `host` is signed, and the payload is
 * UNSIGNED-PAYLOAD, which is what lets a browser PUT the body directly.
 */
function presign(method, key, config, expiresIn, now = Date.now()) {
  const url = new URL(`${config.endpoint}/${config.bucket}/${key}`);
  const { amzDate, dateStamp } = amzDates(now);
  const scope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;

  const query = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&');

  // The path is encoded segment-by-segment: slashes stay real separators.
  const canonicalUri = url.pathname.split('/').map((s) => uriEncode(s)).join('/');
  const canonicalHeaders = `host:${url.host}\n`;

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(config.secretAccessKey, dateStamp, config.region))
    .update(stringToSign)
    .digest('hex');

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function createS3Storage(env = process.env) {
  const config = readConfig(env);
  // Multipart lives in its own module on the official SDK — see s3-multipart.js
  // for why signed query params and XML control bodies are not hand-rolled.
  const { createS3Multipart } = require('./s3-multipart');
  const multipart = createS3Multipart(config, env);

  return {
    name: 's3',
    /** The browser uploads straight to the bucket — bytes skip this server. */
    direct: true,
    /*
     * The storage ADAPTER is multipart-capable. The product multipart transport
     * is not enabled until the socket contract lands (`multipartEnabled` is
     * false), so no 3 GiB upload is possible through the running system yet.
     */
    multipart: true,
    createMultipartUpload: multipart.createMultipartUpload,
    createPartUploadTarget: multipart.createPartUploadTarget,
    listMultipartParts: multipart.listMultipartParts,
    completeMultipartUpload: multipart.completeMultipartUpload,
    abortMultipartUpload: multipart.abortMultipartUpload,
    async createUploadTarget(grant) {
      // The WHOLE grant is forwarded so the shared validator can gate signing.
      const { url, fields } = buildPostPolicy(grant, config, 900);
      return {
        method: 'POST',
        kind: 'post',
        url,
        fields,
        key: grant.key,
        direct: true,
        expectedBytes: grant.expectedBytes,
        maxBytes: grant.maxBytes,
      };
    },
    async createReadUrl(key) {
      // A CDN/custom domain wins when configured; otherwise hand out a
      // time-limited presigned GET so the bucket can stay private.
      if (config.publicBaseUrl) return `${config.publicBaseUrl}/${key}`;
      return presign('GET', key, config, config.readTtl);
    },
    /**
     * HEAD the object at complete time. Even though the POST policy already
     * bounds the size, this proves the object actually LANDED (no upload → no
     * source) and re-checks the size, so nothing broken or oversized is ever
     * attached to a room. Returns null when the object is absent/unreachable.
     */
    async statObject(key) {
      try {
        const res = await fetch(presign('HEAD', key, config, 300), { method: 'HEAD' });
        if (!res.ok) return null;
        const len = Number(res.headers.get('content-length'));
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        return { size: Number.isFinite(len) ? len : 0, contentType: type || undefined };
      } catch {
        return null;
      }
    },
    /**
     * Delete an object — used to clean up a rejected upload (oversized/wrong
     * type) that slipped past the POST policy. Routine expiry is still a bucket
     * lifecycle rule (see docs/uploads.md); this is only the reject path.
     */
    async deleteObject(key) {
      try {
        const res = await fetch(presign('DELETE', key, config, 300), { method: 'DELETE' });
        return res.ok || res.status === 204 || res.status === 404;
      } catch {
        return false;
      }
    },
  };
}

module.exports = {
  createS3Storage,
  // Re-exported under the historical name so existing imports keep working.
  isConfigured: isS3Configured,
  presign,
  uriEncode,
  readConfig,
  buildPostPolicy,
};
