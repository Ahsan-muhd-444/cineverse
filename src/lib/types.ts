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
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  joinedAt: number;
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

export interface RoomSettings {
  hasPassword: boolean;
  waitingRoom: boolean;
  locked: boolean;
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
