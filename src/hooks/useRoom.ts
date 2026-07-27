'use client';

import * as React from 'react';
import type { Socket } from 'socket.io-client';
import { calibrateClock, getSocket } from '@/lib/socket';
import { getProfile, rememberRoom, setProfile } from '@/lib/storage';
import { colorFrom } from '@/lib/utils';
import type {
  ChatMessage,
  ConnectionQuality,
  LobbyEntry,
  MediaSource,
  Member,
  RoomSettings,
  RoomSnapshot,
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
  quality: ConnectionQuality;
  latency: number;
  error: string | null;

  identify: (name: string, password?: string) => void;
  submitPassword: (password: string) => void;
  setSource: (source: MediaSource) => void;
  send: (payload: Partial<ChatMessage> & { kind: ChatMessage['kind'] }) => void;
  setTyping: (isTyping: boolean) => void;
  react: (messageId: string, emoji: string) => void;
  fly: (emoji: string) => void;
  decide: (socketId: string, approve: boolean) => void;
  kick: (socketId: string) => void;
  transferHost: (socketId: string) => void;
  updateSettings: (patch: Partial<{ password: string | null; waitingRoom: boolean; locked: boolean }>) => void;
}

const EMPTY_SETTINGS: RoomSettings = { hasPassword: false, waitingRoom: false, locked: false };

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
  const [latency, setLatency] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  const nameRef = React.useRef('');
  const passwordRef = React.useRef(initialPassword || '');
  const admittedRef = React.useRef(false);

  /* ---------------- applying a snapshot ---------------- */

  const applySnapshot = React.useCallback((snapshot: RoomSnapshot) => {
    setMembers(snapshot.members);
    setLobby(snapshot.lobby);
    setHostId(snapshot.hostId);
    setSettings(snapshot.settings);
    setSourceState(snapshot.source);
    setMessages(snapshot.history || []);
    setPhase('ready');
    admittedRef.current = true;
  }, []);

  /* ---------------- joining ---------------- */

  const attemptJoin = React.useCallback(
    (name: string, password: string) => {
      socket.emit(
        'room:join',
        { code, name, password },
        (res: { ok: boolean; pending?: boolean; snapshot?: RoomSnapshot; error?: string }) => {
          if (!res?.ok) {
            if (res?.error === 'BAD_PASSWORD') {
              setPhase('password');
              setError(passwordRef.current ? 'That passphrase did not match.' : null);
            } else if (res?.error === 'LOCKED') {
              setPhase('denied');
              setError('The host has locked this room.');
            } else {
              setPhase('unreachable');
              setError('Could not join that room.');
            }
            return;
          }
          setError(null);
          if (res.pending) {
            setPhase('waiting');
            return;
          }
          if (res.snapshot) applySnapshot(res.snapshot);
          rememberRoom(code);
        },
      );
    },
    [socket, code, applySnapshot],
  );

  const identify = React.useCallback(
    (name: string, password?: string) => {
      const trimmed = name.trim().slice(0, 24) || 'Guest';
      nameRef.current = trimmed;
      setProfile({ name: trimmed, avatarColor: colorFrom(trimmed) });
      if (password !== undefined) passwordRef.current = password;
      setPhase('connecting');
      attemptJoin(trimmed, passwordRef.current);
    },
    [attemptJoin],
  );

  const submitPassword = React.useCallback(
    (password: string) => {
      passwordRef.current = password;
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
      // Reconnecting mid-film: slip back into the room without asking anything.
      if (admittedRef.current && nameRef.current) attemptJoin(nameRef.current, passwordRef.current);
      else boot();
    };

    const onDisconnect = () => setQuality('offline');

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

    const onSourceSet = (next: MediaSource) => setSourceState(next);
    const onSettings = (next: RoomSettings) => setSettings(next);
    const onApproved = () => {
      socket.emit('lobby:enter', { name: nameRef.current }, (res: { ok: boolean; snapshot?: RoomSnapshot }) => {
        if (res?.ok && res.snapshot) applySnapshot(res.snapshot);
      });
    };
    const onDenied = () => {
      setPhase('denied');
      setError('The host did not let you in.');
    };
    const onKicked = () => {
      admittedRef.current = false;
      setPhase('kicked');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
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

    if (socket.connected) boot();

    return () => {
      cancelled = true;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
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
    };
  }, [socket, attemptJoin, applySnapshot]);

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

  const setSource = React.useCallback(
    (next: MediaSource) => {
      setSourceState(next);
      socket.emit('source:set', next);
    },
    [socket],
  );

  const send = React.useCallback(
    (payload: Partial<ChatMessage> & { kind: ChatMessage['kind'] }) => {
      socket.emit('chat:send', payload);
    },
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

  const decide = React.useCallback(
    (socketId: string, approve: boolean) => socket.emit('lobby:decide', { socketId, approve }),
    [socket],
  );
  const kick = React.useCallback((socketId: string) => socket.emit('room:kick', { socketId }), [socket]);
  const transferHost = React.useCallback(
    (socketId: string) => socket.emit('room:transfer-host', { socketId }),
    [socket],
  );
  const updateSettings = React.useCallback(
    (patch: Partial<{ password: string | null; waitingRoom: boolean; locked: boolean }>) =>
      socket.emit('room:settings', patch),
    [socket],
  );

  /* ---------------- read receipts ---------------- */

  React.useEffect(() => {
    if (phase !== 'ready' || !messages.length) return;
    const last = messages[messages.length - 1];
    if (last.authorId === socket.id) return;
    const id = setTimeout(() => socket.emit('chat:seen', { messageTs: last.ts }), 400);
    return () => clearTimeout(id);
  }, [messages, phase, socket]);

  const me = React.useMemo(() => members.find((m) => m.id === socket.id) ?? null, [members, socket.id]);

  return {
    phase,
    code,
    socket,
    me,
    members,
    lobby,
    hostId,
    isHost: Boolean(socket.id && hostId === socket.id),
    settings,
    source,
    messages,
    typing,
    seenAt,
    quality,
    latency,
    error,
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
  };
}
