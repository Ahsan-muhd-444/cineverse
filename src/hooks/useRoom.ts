'use client';

import * as React from 'react';
import type { Socket } from 'socket.io-client';
import { calibrateClock, getSocket } from '@/lib/socket';
import { clearSeatId, getSeatId } from '@/lib/seat';
import { getProfile, rememberRoom, setProfile } from '@/lib/storage';
import { colorFrom } from '@/lib/utils';
import {
  canAutoJoin,
  classifyJoinFailure,
  eventIsForRoom,
  joinRetryDelay,
  shouldRetryJoin,
  JOIN_ACK_TIMEOUT_MS,
} from '@/hooks/roomLifecycle';
import {
  adoptAuthoritative,
  beginAttempt,
  createAttemptTracker,
  describeActionError,
  normalizeAck,
  shouldRevertAttempt,
} from '@/lib/acks';
import type {
  ChatMessage,
  ConnectionQuality,
  LobbyEntry,
  MediaSource,
  Member,
  PartnerUploadProgress,
  RoomSettings,
  RoomSnapshot,
  UploadAvailability,
} from '@/lib/types';

export type RoomPhase =
  | 'connecting'
  | 'identify'
  | 'password'
  | 'waiting'
  | 'denied'
  | 'kicked'
  | 'ready'
  | 'unreachable';

export interface RoomApi {
  phase: RoomPhase;
  code: string;
  socket: Socket;
  /** My STABLE member id — use this for identity, never socket.id. */
  myId: string;
  me: Member | null;
  members: Member[];
  lobby: LobbyEntry[];
  hostId: string | null;
  isHost: boolean;
  settings: RoomSettings;
  source: MediaSource | null;
  messages: ChatMessage[];
  typing: string[];
  seenAt: Record<string, number>;
  /** Live shared uploads in this room, keyed by stable member id. Safe metadata
   *  only — the server strips tokens, keys, upload ids and part URLs. */
  uploads: PartnerUploadProgress[];
  /** Whether hosted uploads are available on this deployment (server verdict). */
  uploadAvailability: UploadAvailability;
  quality: ConnectionQuality;
  latency: number;
  error: string | null;
  /** Transient copy for a rejected room action (rate limit, not host, no answer).
   *  Distinct from `error`, which drives the terminal room screens. */
  notice: string | null;
  dismissNotice: () => void;

  identify: (name: string, password?: string) => void;
  submitPassword: (password: string) => void;
  setSource: (source: MediaSource) => void;
  /** Resolves with the server's verdict so the composer can report a rejection
   *  (rate limit / oversized attachment) instead of silently dropping it. */
  send: (
    payload: Partial<ChatMessage> & { kind: ChatMessage['kind'] },
  ) => Promise<{ ok: true; id?: string } | { ok: false; error: string; retryAfterMs?: number }>;
  setTyping: (isTyping: boolean) => void;
  react: (messageId: string, emoji: string) => void;
  fly: (emoji: string) => void;
  decide: (socketId: string, approve: boolean) => void;
  kick: (socketId: string) => void;
  transferHost: (socketId: string) => void;
  updateSettings: (patch: Partial<{ password: string | null; waitingRoom: boolean; locked: boolean }>) => void;
  setLights: (mode: 'on' | 'off') => void;
  /** Explicit "leave this room" — immediate, no reconnect grace. */
  leave: () => void;
}

const EMPTY_SETTINGS: RoomSettings = { hasPassword: false, waitingRoom: false, locked: false, lightsMode: 'on' };

/**
 * Owns the entire lifecycle of one room: connecting, being let in, staying in
 * sync with presence and chat, and recovering when the network blinks.
 */
export function useRoom(code: string, initialPassword?: string): RoomApi {
  const socket = React.useMemo(() => getSocket(), []);

  const [phase, setPhase] = React.useState<RoomPhase>('connecting');
  const [members, setMembers] = React.useState<Member[]>([]);
  const [lobby, setLobby] = React.useState<LobbyEntry[]>([]);
  const [hostId, setHostId] = React.useState<string | null>(null);
  const [settings, setSettings] = React.useState<RoomSettings>(EMPTY_SETTINGS);
  const [source, setSourceState] = React.useState<MediaSource | null>(null);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [typing, setTyping] = React.useState<string[]>([]);
  const [seenAt, setSeenAt] = React.useState<Record<string, number>>({});
  const [quality, setQuality] = React.useState<ConnectionQuality>('good');
  /*
   * Partner upload progress, keyed by STABLE member id.
   *
   * Room state rather than a transient event: a member who joins mid-upload gets
   * it in their snapshot, and every clear path on the server sends an explicit
   * `cleared` so the room never keeps showing an upload nobody owns.
   */
  const [uploads, setUploads] = React.useState<PartnerUploadProgress[]>([]);
  /*
   * Whether hosted uploads are available on this deployment (the server's verdict,
   * carried in every snapshot). Optimistic default keeps the picker showing the
   * upload affordance until the first snapshot arrives; a demo deploy corrects it
   * to `disabled` on join, before a file could realistically be chosen.
   */
  const [uploadAvailability, setUploadAvailability] = React.useState<UploadAvailability>({
    enabled: true,
    mode: 'local-dev',
  });
  const [latency, setLatency] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  // A transient, dismissible message: a rejected action (kick, settings, lights,
  // approve) or a server restart. Deliberately separate from `error`, which
  // drives the terminal full-screen states — "too fast, try again" must never
  // look like the room fell over.
  const [notice, setNotice] = React.useState<string | null>(null);
  // The stable seat the server assigned us. Identity for chat, presence, host
  // checks and WebRTC routing — socket.id is transport only, and changes on
  // every refresh.
  const [myId, setMyId] = React.useState('');

  // Per-tab, per-room token that lets a refresh reclaim this exact seat.
  const seatId = React.useMemo(() => getSeatId(code), [code]);

  const nameRef = React.useRef('');
  const passwordRef = React.useRef(initialPassword || '');
  const admittedRef = React.useRef(false);
  // Late acknowledgements are normal — a slow link, a room we have since left.
  // Nothing they carry may touch state once this hook is gone.
  const mountedRef = React.useRef(true);
  const noticeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last source value we believe the room holds, mirrored as a ref so an
  // acknowledgement that arrives several renders later still knows what to
  // restore without capturing a stale closure.
  const sourceRef = React.useRef<MediaSource | null>(null);
  // Shared by optimistic source attempts AND authoritative source updates, so a
  // late rejection can tell whether anything newer has happened since.
  const sourceAttempts = React.useRef(createAttemptTracker());
  // Same ordering guard for joins: a reply for a superseded attempt (a retry
  // landed first, or the user re-identified) must not move the UI backwards.
  const joinAttempts = React.useRef(createAttemptTracker());
  const joinRetriesRef = React.useRef(0);
  const joinRetryTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptJoinRef = React.useRef<((name: string, password: string, attempt?: number) => void) | null>(null);
  // The room code for which automatic (re)joining is blocked because the room
  // reached a terminal state — closed, denied, kicked or locked. A bare
  // Socket.IO reconnect must NOT retry these; only navigation to a new code (a
  // fresh hook) clears it. Code-aware, not a boolean, so a stale marker from a
  // previous room can never block a new one.
  const terminalCodeRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      // A pending join retry must never fire into an unmounted room.
      if (joinRetryTimer.current) clearTimeout(joinRetryTimer.current);
    };
  }, []);

  /* ---------------- transient notices ---------------- */

  const dismissNotice = React.useCallback(() => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(null);
  }, []);

  /** Show a message that clears itself — never a state the user has to escape. */
  const showNotice = React.useCallback((text: string, ttlMs = 6000) => {
    if (!mountedRef.current) return;
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      if (mountedRef.current) setNotice(null);
    }, ttlMs);
  }, []);

  const reportActionError = React.useCallback(
    (reason: string, retryAfterMs?: number) => showNotice(describeActionError(reason, retryAfterMs)),
    [showNotice],
  );

  /**
   * Emit a room action and hold it to an answer.
   *
   * Every path settles exactly once: the server's reply, or a timeout. Without
   * the timeout a lost acknowledgement leaves the caller waiting forever, which
   * is how a control ends up permanently "pending" with no way back.
   */
  const emitAction = React.useCallback(
    (event: string, payload: unknown) => {
      let settled = false;
      const finish = (res: unknown, fallback: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const ack = normalizeAck(res, fallback);
        if (!ack.ok) reportActionError(ack.error, ack.retryAfterMs);
      };
      const timer = setTimeout(() => finish(null, 'TIMEOUT'), 10000);
      socket.emit(event, payload, (res: unknown) => finish(res, 'FAILED'));
    },
    [socket, reportActionError],
  );

  /* ---------------- source state ---------------- */

  /** Write a source to state and to the mirror the acknowledgements read. */
  const commitSource = React.useCallback((next: MediaSource | null) => {
    sourceRef.current = next;
    setSourceState(next);
  }, []);

  /** The server told us what the source IS. That always wins over anything local. */
  const adoptSource = React.useCallback(
    (next: MediaSource | null) => {
      adoptAuthoritative(sourceAttempts.current);
      commitSource(next);
    },
    [commitSource],
  );

  /* ---------------- terminal states ---------------- */

  // Record a terminal room state: never auto-rejoin this code, and drop any
  // claim to membership. Preserves the passed phase + message.
  const markTerminal = React.useCallback(
    (nextPhase: RoomPhase, message: string | null) => {
      terminalCodeRef.current = code;
      admittedRef.current = false;
      // Nothing may quietly retry a room that has ended.
      if (joinRetryTimer.current) {
        clearTimeout(joinRetryTimer.current);
        joinRetryTimer.current = null;
      }
      setPhase(nextPhase);
      setError(message);
    },
    [code],
  );

  // A genuinely new room: clear the previous code's terminal marker and stale
  // membership so the new code boots normally. This runs on mount and on a code
  // change — never on a transport reconnect, which leaves `code` unchanged.
  React.useEffect(() => {
    terminalCodeRef.current = null;
    admittedRef.current = false;
  }, [code]);

  /* ---------------- applying a snapshot ---------------- */

  const applySnapshot = React.useCallback(
    (snapshot: RoomSnapshot) => {
      setMembers(snapshot.members);
      setLobby(snapshot.lobby);
      setHostId(snapshot.hostId);
      setSettings(snapshot.settings);
      // A snapshot is the server's word on the source, so it also voids any
      // optimistic change still in flight from before the (re)join.
      adoptSource(snapshot.source);
      setMessages(snapshot.history || []);
      setUploads(snapshot.uploads || []);
      // Older servers may omit this; keep the current (enabled) default if so.
      if (snapshot.uploadAvailability) setUploadAvailability(snapshot.uploadAvailability);
      setPhase('ready');
      // admittedRef is true ONLY once a valid snapshot has actually been applied.
      admittedRef.current = true;
    },
    [adoptSource],
  );

  /* ---------------- joining ---------------- */

  /**
   * Ask to be let in, and always reach a conclusion.
   *
   * Two failure modes used to end here permanently: a lost acknowledgement left
   * the room on the connecting spinner forever, and a rate-limited join was
   * shown as an unexplained "could not join" when waiting a moment would have
   * worked. Both now settle — once — into a state the user can act on, with
   * bounded automatic retries that respect the server's own backoff.
   */
  const attemptJoin = React.useCallback(
    (name: string, password: string, attempt = 1) => {
      // A newer attempt supersedes anything still in flight.
      const seq = beginAttempt(joinAttempts.current);
      let settled = false;

      const finish = (
        res:
          | {
              ok?: boolean;
              pending?: boolean;
              reclaimed?: boolean;
              memberId?: string;
              snapshot?: RoomSnapshot;
              error?: string;
              retryAfterMs?: number;
            }
          | null,
        fallback: string,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!mountedRef.current) return;
        // A late reply for a superseded attempt must not move the UI.
        if (!shouldRevertAttempt(joinAttempts.current, seq)) return;

        if (res?.ok) {
          setError(null);
          joinRetriesRef.current = 0;
          if (res.pending) {
            // Waiting for approval is not membership.
            admittedRef.current = false;
            setPhase('waiting');
            return;
          }
          if (res.memberId) setMyId(res.memberId);
          if (res.snapshot) applySnapshot(res.snapshot);
          rememberRoom(code);
          return;
        }

        const error = res?.error || fallback;
        const kind = classifyJoinFailure(error);
        admittedRef.current = false;

        if (kind === 'password') {
          setPhase('password');
          setError(passwordRef.current ? 'That passphrase did not match.' : null);
          return;
        }
        if (kind === 'terminal') {
          // LOCKED -> the denied screen; KICKED -> the kicked screen. Both are
          // terminal: a bare reconnect must not silently retry them.
          if (error === 'LOCKED') markTerminal('denied', 'The host has locked this room.');
          else markTerminal('kicked', 'The host removed you from this room.');
          return;
        }
        if (shouldRetryJoin(kind, attempt)) {
          // Transient — the room is fine, we were just early. Say so, and come
          // back after the delay the server asked for rather than hammering it.
          setPhase('connecting');
          setError(
            error === 'RATE_LIMITED'
              ? 'Too many attempts just now — trying again shortly…'
              : 'Reconnecting to the room…',
          );
          joinRetriesRef.current = attempt;
          const delay = joinRetryDelay(res?.retryAfterMs, attempt);
          const retry = setTimeout(() => {
            joinRetryTimer.current = null;
            if (!mountedRef.current) return;
            if (!canAutoJoin(code, terminalCodeRef.current)) return;
            attemptJoinRef.current?.(name, password, attempt + 1);
          }, delay);
          if (joinRetryTimer.current) clearTimeout(joinRetryTimer.current);
          joinRetryTimer.current = retry;
          return;
        }

        // Out of retries, or a failure a retry cannot fix. Not terminal — a real
        // reconnect may still succeed — but the spinner has to stop.
        setPhase('unreachable');
        setError(
          kind === 'retry'
            ? 'The room is not responding. Check your connection and try again.'
            : 'Could not join that room.',
        );
      };

      const timer = setTimeout(() => finish(null, 'TIMEOUT'), JOIN_ACK_TIMEOUT_MS);
      socket.emit('room:join', { code, name, password, seatId }, (res: Parameters<typeof finish>[0]) =>
        finish(res, 'JOIN_FAILED'),
      );
    },
    [socket, code, seatId, applySnapshot, markTerminal],
  );

  // Retries re-enter the latest `attemptJoin` without it depending on itself.
  React.useEffect(() => {
    attemptJoinRef.current = attemptJoin;
    return () => {
      attemptJoinRef.current = null;
    };
  }, [attemptJoin]);

  const identify = React.useCallback(
    (name: string, password?: string) => {
      const trimmed = name.trim().slice(0, 24) || 'Guest';
      nameRef.current = trimmed;
      setProfile({ name: trimmed, avatarColor: colorFrom(trimmed) });
      if (password !== undefined) passwordRef.current = password;
      // Deliberate user intent resets the automatic-retry budget.
      joinRetriesRef.current = 0;
      setPhase('connecting');
      attemptJoin(trimmed, passwordRef.current);
    },
    [attemptJoin],
  );

  const submitPassword = React.useCallback(
    (password: string) => {
      passwordRef.current = password;
      joinRetriesRef.current = 0;
      setPhase('connecting');
      attemptJoin(nameRef.current, password);
    },
    [attemptJoin],
  );

  /* ---------------- wiring ---------------- */

  React.useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      await calibrateClock(socket);
      if (cancelled) return;
      // A terminal event (or navigation) can land while calibrateClock() is in
      // flight, so re-check here as well as in onConnect before joining.
      if (!canAutoJoin(code, terminalCodeRef.current)) return;
      setLatency(Math.round((socket as unknown as { _clockRtt?: number })._clockRtt ?? 0));

      const stored = getProfile();
      if (stored.name) {
        nameRef.current = stored.name;
        attemptJoin(stored.name, passwordRef.current);
      } else {
        setPhase('identify');
      }
    };

    const onConnect = () => {
      setQuality('good');
      // The transport is back, so any queued retry is stale — reconnecting IS
      // the retry, and letting both run would double-join.
      if (joinRetryTimer.current) {
        clearTimeout(joinRetryTimer.current);
        joinRetryTimer.current = null;
      }
      joinRetriesRef.current = 0;
      // A room that reached a terminal state (closed / denied / kicked / locked)
      // must not auto-rejoin just because the transport reconnected — that is not
      // user intent. Leave the terminal phase and error exactly as they are.
      if (!canAutoJoin(code, terminalCodeRef.current)) return;
      // Reconnecting mid-film: slip back into the room without asking anything.
      if (admittedRef.current && nameRef.current) attemptJoin(nameRef.current, passwordRef.current);
      else boot();
    };

    const onDisconnect = () => setQuality('offline');

    // The server is restarting on purpose. Distinguishing this from a network
    // blip matters: the room state is genuinely gone, but the SEAT is not — the
    // socket reconnects and rejoins with the same seat token, so the right UI is
    // "reconnecting", not an error. Room content is deliberately left on screen
    // until a fresh snapshot replaces it.
    const onServerShutdown = () => {
      setQuality('offline');
      if (admittedRef.current) showNotice('The room is restarting — reconnecting…', 12000);
    };

    const onPresence = (payload: { members: Member[]; lobby: LobbyEntry[]; hostId: string | null }) => {
      setMembers(payload.members);
      setLobby(payload.lobby);
      setHostId(payload.hostId);
    };

    const onMessage = (message: ChatMessage) => {
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      setTyping((prev) => prev.filter((n) => n !== message.author));
    };

    const onTyping = ({ name, isTyping }: { name: string; isTyping: boolean }) => {
      setTyping((prev) => {
        if (isTyping) return prev.includes(name) ? prev : [...prev, name];
        return prev.filter((n) => n !== name);
      });
    };

    const onSeen = ({ id, at }: { id: string; at: number }) => {
      setSeenAt((prev) => ({ ...prev, [id]: at }));
    };

    const onReact = ({ messageId, emoji, byId }: { messageId: string; emoji: string; byId: string }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          const reactions = { ...(m.reactions || {}) };
          const list = new Set(reactions[emoji] || []);
          if (list.has(byId)) list.delete(byId);
          else list.add(byId);
          if (list.size) reactions[emoji] = [...list];
          else delete reactions[emoji];
          return { ...m, reactions };
        }),
      );
    };

    // The room's authoritative source. Adopting it also cancels the revert of
    // any optimistic change we still have outstanding — the room has spoken.
    const onSourceSet = (next: MediaSource) => adoptSource(next);
    const onSettings = (next: RoomSettings) => setSettings(next);
    // Admission is now completed on the server; the approval carries the
    // snapshot directly, so there is nothing to emit back. Ignore a stray
    // approval for a room we are no longer managing.
    const onApproved = (payload: { code?: string; memberId?: string; snapshot?: RoomSnapshot } | null) => {
      if (!eventIsForRoom(payload?.code, code)) return;
      if (payload?.memberId) setMyId(payload.memberId);
      if (payload?.snapshot) {
        applySnapshot(payload.snapshot);
        rememberRoom(code);
      }
    };
    // Each terminal event carries its room code; ignore delayed ones meant for a
    // room this hook has already left, so they can't hijack the current room.
    const onDenied = (payload: { code?: string } | null) => {
      if (!eventIsForRoom(payload?.code, code)) return;
      markTerminal('denied', 'The host did not let you in.');
    };
    const onKicked = (payload: { code?: string } | null) => {
      if (!eventIsForRoom(payload?.code, code)) return;
      markTerminal('kicked', 'The host removed you from this room.');
    };
    // The last approved member left while we were still waiting: the session is
    // over. Treat it as terminal, not a reconnect.
    const onClosed = (payload: { code?: string } | null) => {
      if (!eventIsForRoom(payload?.code, code)) return;
      markTerminal('unreachable', 'This room has closed — the host left before you were let in.');
    };

    /*
     * One event for both directions: a payload with `cleared` removes the entry,
     * anything else replaces it. Replacing by member id means a burst of updates
     * can never accumulate duplicate rows for one uploader.
     */
    const onUploadProgress = (payload: (PartnerUploadProgress & { cleared?: boolean }) | null) => {
      if (!payload || typeof payload.memberId !== 'string') return;
      setUploads((current) => {
        const rest = current.filter((entry) => entry.memberId !== payload.memberId);
        return payload.cleared ? rest : [...rest, payload as PartnerUploadProgress];
      });
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('upload:progress', onUploadProgress);
    socket.on('presence', onPresence);
    socket.on('message', onMessage);
    socket.on('chat:typing', onTyping);
    socket.on('chat:seen', onSeen);
    socket.on('chat:react', onReact);
    socket.on('source:set', onSourceSet);
    socket.on('room:settings', onSettings);
    socket.on('lobby:approved', onApproved);
    socket.on('lobby:denied', onDenied);
    socket.on('room:kicked', onKicked);
    socket.on('room:closed', onClosed);
    socket.on('server:shutdown', onServerShutdown);

    if (socket.connected) boot();

    return () => {
      cancelled = true;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('upload:progress', onUploadProgress);
      socket.off('presence', onPresence);
      socket.off('message', onMessage);
      socket.off('chat:typing', onTyping);
      socket.off('chat:seen', onSeen);
      socket.off('chat:react', onReact);
      socket.off('source:set', onSourceSet);
      socket.off('room:settings', onSettings);
      socket.off('lobby:approved', onApproved);
      socket.off('lobby:denied', onDenied);
      socket.off('room:kicked', onKicked);
      socket.off('room:closed', onClosed);
      socket.off('server:shutdown', onServerShutdown);
    };
  }, [socket, code, attemptJoin, applySnapshot, markTerminal, adoptSource, showNotice]);

  /* ---------------- leaving ---------------- */

  /**
   * Explicit "leave this room" — the only path that gives up the seat straight
   * away. Deliberately NOT wired to unmount: a refresh unmounts the tree too,
   * and emitting a leave there is what made a reload look like a departure.
   * A plain unmount now relies on the server's reconnect grace, and a room
   * SWITCH is handled server-side (joining another room departs the old one).
   */
  const leave = React.useCallback(() => {
    admittedRef.current = false;
    // Drop this tab's claim so the seat can't be reclaimed after leaving.
    clearSeatId(code);
    if (socket.connected) socket.emit('room:leave', { code });
  }, [socket, code]);

  /* ---------------- link quality ---------------- */

  React.useEffect(() => {
    const id = setInterval(() => {
      if (!socket.connected) {
        setQuality('offline');
        return;
      }
      const sent = Date.now();
      socket.emit('clock:ping', sent, () => {
        const rtt = Date.now() - sent;
        setLatency(rtt);
        setQuality(rtt < 90 ? 'excellent' : rtt < 200 ? 'good' : rtt < 450 ? 'fair' : 'poor');
      });
    }, 5000);
    return () => clearInterval(id);
  }, [socket]);

  /* ---------------- actions ---------------- */

  /**
   * Change what the room is watching.
   *
   * Optimistic for responsiveness, but the rollback is ORDER-AWARE. Two quick
   * changes A then B, with A rejected after B was accepted, must leave B alone:
   * the attempt tracker makes "is my revert still the newest thing that
   * happened?" a decidable question, and an authoritative `source:set` bumps it
   * too, so an accepted change can never be undone by a straggling rejection.
   */
  const setSource = React.useCallback(
    (next: MediaSource) => {
      const previous = sourceRef.current;
      const attempt = beginAttempt(sourceAttempts.current);
      commitSource(next);

      let settled = false;
      const finish = (res: unknown, fallback: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const ack = normalizeAck(res, fallback);
        if (ack.ok) return;
        // No answer is not evidence the room took it. Revert — unless something
        // newer has landed since, in which case that value is the truth now.
        if (!mountedRef.current) return;
        if (!shouldRevertAttempt(sourceAttempts.current, attempt)) return;
        commitSource(previous);
        reportActionError(ack.error, ack.retryAfterMs);
      };
      const timer = setTimeout(() => finish(null, 'TIMEOUT'), 10000);
      socket.emit('source:set', next, (res: unknown) => finish(res, 'FAILED'));
    },
    [socket, commitSource, reportActionError],
  );

  const send = React.useCallback(
    (payload: Partial<ChatMessage> & { kind: ChatMessage['kind'] }) =>
      new Promise<{ ok: true; id?: string } | { ok: false; error: string; retryAfterMs?: number }>((resolve) => {
        // Never hang the composer if the ack is lost.
        const timer = setTimeout(() => resolve({ ok: false, error: 'TIMEOUT' }), 12000);
        socket.emit(
          'chat:send',
          payload,
          (res: { ok?: boolean; id?: string; error?: string; retryAfterMs?: number } | null) => {
            clearTimeout(timer);
            if (res?.ok) resolve({ ok: true, id: res.id });
            else resolve({ ok: false, error: res?.error || 'SEND_FAILED', retryAfterMs: res?.retryAfterMs });
          },
        );
      }),
    [socket],
  );

  const setTypingState = React.useCallback(
    (isTyping: boolean) => {
      socket.emit('chat:typing', isTyping);
    },
    [socket],
  );

  const react = React.useCallback(
    (messageId: string, emoji: string) => {
      socket.emit('chat:react', { messageId, emoji });
    },
    [socket],
  );

  const fly = React.useCallback(
    (emoji: string) => {
      socket.emit('room:reaction', { emoji });
    },
    [socket],
  );

  // Deliberate user actions: each one is acked and reports a rejection, so a
  // rate-limited or unauthorized control never just silently does nothing.
  const decide = React.useCallback(
    (socketId: string, approve: boolean) => emitAction('lobby:decide', { socketId, approve }),
    [emitAction],
  );
  const kick = React.useCallback((socketId: string) => emitAction('room:kick', { socketId }), [emitAction]);
  const transferHost = React.useCallback(
    (socketId: string) => emitAction('room:transfer-host', { socketId }),
    [emitAction],
  );
  const updateSettings = React.useCallback(
    (patch: Partial<{ password: string | null; waitingRoom: boolean; locked: boolean }>) =>
      emitAction('room:settings', patch),
    [emitAction],
  );
  const setLights = React.useCallback((mode: 'on' | 'off') => emitAction('room:lights', { mode }), [emitAction]);

  /* ---------------- read receipts ---------------- */

  React.useEffect(() => {
    if (phase !== 'ready' || !messages.length) return;
    const last = messages[messages.length - 1];
    if (last.authorId === myId) return;
    const id = setTimeout(() => socket.emit('chat:seen', { messageTs: last.ts }), 400);
    return () => clearTimeout(id);
  }, [messages, phase, socket, myId]);

  const me = React.useMemo(() => members.find((m) => m.id === myId) ?? null, [members, myId]);

  return {
    phase,
    code,
    socket,
    myId,
    me,
    members,
    lobby,
    hostId,
    isHost: Boolean(myId && hostId === myId),
    settings,
    source,
    messages,
    typing,
    seenAt,
    // Other members' shared uploads, safe metadata only (no tokens, keys or URLs).
    uploads,
    // Whether hosted uploads are available on this deployment (server verdict).
    uploadAvailability,
    quality,
    latency,
    error,
    notice,
    dismissNotice,
    identify,
    submitPassword,
    setSource,
    send,
    setTyping: setTypingState,
    react,
    fly,
    decide,
    kick,
    transferHost,
    updateSettings,
    setLights,
    leave,
  };
}
