export type SourceType = 'catalog' | 'url' | 'youtube' | 'local';

export interface QualityVariant {
  label: string;
  value: string;
}

export interface MediaSource {
  type: SourceType;
  value: string;
  label: string;
  poster?: string;
  quality?: string;
  variants?: QualityVariant[];
  subtitles?: { label: string; src: string; lang: string }[];
}

export interface MediaState {
  mic: boolean;
  cam: boolean;
  screen: boolean;
  inCall: boolean;
}

export interface Member {
  /** Stable seat id — survives refreshes and brief drops, unlike a socket id. */
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  joinedAt: number;
  /** False while the member is inside their reconnect grace window. */
  connected: boolean;
  media: MediaState;
}

export interface LobbyEntry {
  socketId: string;
  name: string;
  at: number;
}

export type MessageKind = 'text' | 'image' | 'gif' | 'file' | 'voice' | 'system';

export interface ChatMessage {
  id: string;
  kind: MessageKind;
  authorId?: string;
  author?: string;
  color?: string;
  ts: number;
  text?: string;
  replyTo?: string | null;
  data?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  duration?: number;
  width?: number;
  height?: number;
  reactions?: Record<string, string[]>;
  pending?: boolean;
}

export type LightsMode = 'on' | 'off';

export interface RoomSettings {
  hasPassword: boolean;
  waitingRoom: boolean;
  locked: boolean;
  /** Shared cinema ambience — 'off' dims the room around the film for everyone. */
  lightsMode: LightsMode;
}

/**
 * A member's shared-upload progress, as broadcast to the room.
 *
 * Everything here is safe to show to the other member: no token, no object key,
 * no upload id, no presigned URL, and no speed or ETA (those are the uploader's
 * local estimates and would need their own realtime traffic to stay current).
 * The percentage is computed by the server, not the reporting client.
 */
export interface PartnerUploadProgress {
  memberId: string;
  memberName: string;
  label: string;
  uploadedBytes: number;
  totalBytes: number;
  percentage: number;
  status: 'uploading' | 'paused' | 'retrying' | 'reconnecting' | 'finalizing';
}

/**
 * Whether THIS deployment accepts hosted (shared) uploads, decided entirely on the
 * server. `disabled` is production with no object storage — the picker shows a
 * clear demo message instead of an upload control that would only fail on submit.
 */
export interface UploadAvailability {
  enabled: boolean;
  mode: 'disabled' | 'local-dev' | 's3';
}

export interface RoomSnapshot {
  code: string;
  source: MediaSource | null;
  playing: boolean;
  time: number;
  rate: number;
  serverTime: number;
  members: Member[];
  lobby: LobbyEntry[];
  hostId: string | null;
  settings: RoomSettings;
  /** Active shared uploads, so a member joining mid-upload sees the same state. */
  uploads?: PartnerUploadProgress[];
  /** Whether hosted uploads are available on this deployment (server verdict). */
  uploadAvailability?: UploadAvailability;
  history: ChatMessage[];
}

export type ConnectionQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'offline';

export interface Movie {
  id: string;
  title: string;
  year: number;
  runtime: number;
  rating: number;
  genres: string[];
  tagline: string;
  overview: string;
  poster: string;
  backdrop: string;
  cast: { name: string; role: string }[];
  director: string;
  trailer?: string;
  /** Direct, streamable source. Present for every title in the built-in catalog. */
  src: string;
  variants?: QualityVariant[];
  accent: string;
}

export interface WatchProgress {
  movieId: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export interface Profile {
  name: string;
  avatarColor: string;
}
