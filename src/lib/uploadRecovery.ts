/**
 * Refresh recovery for a resumable upload.
 *
 * A browser cannot hand a `File` back after a reload — the reference dies with
 * the page and no API restores it. This module therefore does NOT pretend to
 * resume automatically: it persists the small amount of metadata needed to
 * recognise the session, and the interface asks the user to pick the same file
 * again.
 *
 * What is persisted, and what is deliberately not:
 *
 *   PERSISTED   the session token, the file fingerprint, the plan, the room
 *   NEVER       the File, a Blob, part bytes, object URLs, part URLs, ETags
 *
 * The token lives in `sessionStorage`, not `localStorage`. It is a six-hour
 * capability for writing gigabytes to a bucket; `sessionStorage` dies with the
 * tab, which is exactly the lifetime of the thing it is recovering. A
 * `localStorage` copy would outlive the upload, the room and the tab.
 *
 * Pure with respect to the environment: the storage object is injected, so the
 * rules are testable with a plain Map-backed stub.
 */

export const UPLOAD_RECOVERY_VERSION = 1;
const KEY_PREFIX = 'cineverse.upload.session.';
const SINGLE_KEY_PREFIX = 'cineverse.upload.single.';

/** The file identity we can compare after a reselection. */
export interface FileFingerprint {
  fileName: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface RecoverableSession extends FileFingerprint {
  version: number;
  mode: 'multipart';
  token: string;
  partSize: number;
  partCount: number;
  expiresAt: number;
  roomCode: string;
}

/**
 * A SINGLE-SHOT lifecycle-cleanup record — separate from multipart recovery.
 *
 * A single-shot upload has no byte-transfer to resume, but its server session is
 * an active capability that only the token can close. When a controller is
 * destroyed mid-single-upload (a remount, a bare swap), this is the ONLY thing
 * that lets the next controller discover and abort that session. It carries no
 * file fingerprint or plan — there is nothing to reselect, only a lifecycle to
 * end. Tab-scoped (`sessionStorage`) for the same reason the multipart token is.
 */
export interface SingleCleanupRecord {
  version: number;
  mode: 'single';
  roomCode: string;
  token: string;
  fileName: string;
  size: number;
  expiresAt: number;
}

/** The minimal slice of the Web Storage API this needs. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const storageKey = (roomCode: string) => `${KEY_PREFIX}${roomCode}`;
const singleStorageKey = (roomCode: string) => `${SINGLE_KEY_PREFIX}${roomCode}`;

/** The fingerprint of a File, as the four properties a browser exposes. */
export function fingerprintOf(file: File): FileFingerprint {
  return { fileName: file.name, size: file.size, type: file.type, lastModified: file.lastModified };
}

/**
 * Save a resumable session.
 *
 * Returns false rather than throwing when storage is unavailable (private mode,
 * a full quota, a blocked origin): losing the ability to recover after a refresh
 * must never break the upload that is currently working.
 */
export function saveSession(store: KeyValueStore | null, session: RecoverableSession): boolean {
  if (!store) return false;
  try {
    store.setItem(storageKey(session.roomCode), JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a session for this room, or null.
 *
 * Anything unreadable, out-of-version, expired or structurally wrong is treated
 * as absent AND cleared — a half-valid record is worse than none, because the
 * interface would offer a resume that cannot work.
 */
export function loadSession(store: KeyValueStore | null, roomCode: string, now = Date.now()): RecoverableSession | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(storageKey(roomCode));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearSession(store, roomCode);
    return null;
  }

  const session = parsed as Partial<RecoverableSession> | null;
  const valid =
    !!session &&
    typeof session === 'object' &&
    session.version === UPLOAD_RECOVERY_VERSION &&
    session.mode === 'multipart' &&
    typeof session.token === 'string' &&
    session.token.length > 0 &&
    typeof session.fileName === 'string' &&
    Number.isSafeInteger(session.size) &&
    (session.size as number) > 0 &&
    typeof session.type === 'string' &&
    Number.isSafeInteger(session.lastModified) &&
    Number.isSafeInteger(session.partSize) &&
    Number.isSafeInteger(session.partCount) &&
    Number.isSafeInteger(session.expiresAt) &&
    session.roomCode === roomCode;

  if (!valid) {
    clearSession(store, roomCode);
    return null;
  }
  // An expired token cannot be renewed — renewal requires a still-valid one — so
  // there is nothing to offer the user.
  if ((session.expiresAt as number) <= now) {
    clearSession(store, roomCode);
    return null;
  }
  return session as RecoverableSession;
}

export function clearSession(store: KeyValueStore | null, roomCode: string): void {
  if (!store) return;
  try {
    store.removeItem(storageKey(roomCode));
  } catch {
    /* nothing useful to do — the record is unreachable either way */
  }
}

/* -------------------------------------------------------------------------- */
/*  Single-shot lifecycle cleanup                                             */
/* -------------------------------------------------------------------------- */

/** Persist an unresolved single-shot lifecycle. Best-effort, never throws. */
export function saveSingleCleanup(store: KeyValueStore | null, record: SingleCleanupRecord): boolean {
  if (!store) return false;
  try {
    store.setItem(singleStorageKey(record.roomCode), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a single-shot cleanup record for this room, or null. Anything unreadable,
 * out-of-version, expired or structurally wrong is treated as absent AND cleared —
 * an expired single token cannot close its session, so there is nothing to do.
 */
export function loadSingleCleanup(
  store: KeyValueStore | null,
  roomCode: string,
  now = Date.now(),
): SingleCleanupRecord | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(singleStorageKey(roomCode));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearSingleCleanup(store, roomCode);
    return null;
  }

  const rec = parsed as Partial<SingleCleanupRecord> | null;
  const valid =
    !!rec &&
    typeof rec === 'object' &&
    rec.version === UPLOAD_RECOVERY_VERSION &&
    rec.mode === 'single' &&
    typeof rec.token === 'string' &&
    rec.token.length > 0 &&
    typeof rec.fileName === 'string' &&
    Number.isSafeInteger(rec.size) &&
    (rec.size as number) > 0 &&
    Number.isSafeInteger(rec.expiresAt) &&
    rec.roomCode === roomCode;

  if (!valid) {
    clearSingleCleanup(store, roomCode);
    return null;
  }
  if ((rec.expiresAt as number) <= now) {
    clearSingleCleanup(store, roomCode);
    return null;
  }
  return rec as SingleCleanupRecord;
}

export function clearSingleCleanup(store: KeyValueStore | null, roomCode: string): void {
  if (!store) return;
  try {
    store.removeItem(singleStorageKey(roomCode));
  } catch {
    /* unreachable either way */
  }
}

/**
 * Is this the same file the upload started with?
 *
 * All four properties, exactly. A same-name, same-size re-encode would produce a
 * different `lastModified`, and resuming across it would splice two different
 * films into one object that passes every size check and plays as garbage. The
 * cost of being strict is one extra user action; the cost of being loose is a
 * corrupt movie nobody can explain.
 */
export function matchesFingerprint(session: FileFingerprint, file: File): boolean {
  return (
    session.fileName === file.name &&
    session.size === file.size &&
    session.type === file.type &&
    session.lastModified === file.lastModified
  );
}

/** Which property disagreed, for a message the user can act on. */
export function describeFingerprintMismatch(session: FileFingerprint, file: File): string | null {
  if (session.fileName !== file.name) return 'That is a different file name than the upload started with.';
  if (session.size !== file.size) return 'That file is a different size than the upload started with.';
  if (session.type !== file.type) return 'That file is a different type than the upload started with.';
  if (session.lastModified !== file.lastModified) {
    return 'That file has been modified since the upload started.';
  }
  return null;
}

/** The tab-scoped store, or null when Web Storage is unavailable. */
export function sessionStore(): KeyValueStore | null {
  if (typeof window === 'undefined') return null;
  try {
    // Touch it: Safari in private mode throws on access, not on use.
    const probe = window.sessionStorage;
    probe.getItem(`${KEY_PREFIX}probe`);
    return probe;
  } catch {
    return null;
  }
}
