'use client';

import type { Profile, WatchProgress } from './types';
import { colorFrom } from './utils';

/**
 * A very small, typed wrapper over localStorage.
 * Everything degrades to a sensible default when storage is unavailable
 * (private windows, SSR, blocked third-party contexts).
 */

const KEYS = {
  profile: 'cineverse:profile',
  favorites: 'cineverse:favorites',
  watchLater: 'cineverse:watch-later',
  progress: 'cineverse:progress',
  settings: 'cineverse:settings',
  recentRooms: 'cineverse:recent-rooms',
} as const;

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent('cineverse:storage', { detail: { key } }));
  } catch {
    /* quota or privacy mode — nothing we can do, and nothing worth breaking over */
  }
}

/* ---------------- profile ---------------- */

export function getProfile(): Profile {
  const stored = read<Partial<Profile> | null>(KEYS.profile, null);
  if (stored?.name) {
    return { name: stored.name, avatarColor: stored.avatarColor || colorFrom(stored.name) };
  }
  return { name: '', avatarColor: '#8b5cf6' };
}

export function setProfile(profile: Profile): void {
  write(KEYS.profile, profile);
}

/* ---------------- lists ---------------- */

export const getFavorites = () => read<string[]>(KEYS.favorites, []);
export const getWatchLater = () => read<string[]>(KEYS.watchLater, []);

function toggleIn(key: string, id: string): string[] {
  const list = read<string[]>(key, []);
  const next = list.includes(id) ? list.filter((x) => x !== id) : [id, ...list];
  write(key, next);
  return next;
}

export const toggleFavorite = (id: string) => toggleIn(KEYS.favorites, id);
export const toggleWatchLater = (id: string) => toggleIn(KEYS.watchLater, id);

/* ---------------- continue watching ---------------- */

export function getProgress(): WatchProgress[] {
  return read<WatchProgress[]>(KEYS.progress, []);
}

export function saveProgress(entry: WatchProgress): void {
  const all = getProgress().filter((p) => p.movieId !== entry.movieId);
  // Anything under 30s or past 95% isn't worth resuming.
  const meaningful = entry.position > 30 && (!entry.duration || entry.position < entry.duration * 0.95);
  const next = meaningful ? [entry, ...all] : all;
  write(KEYS.progress, next.slice(0, 20));
}

export function getProgressFor(movieId: string): WatchProgress | undefined {
  return getProgress().find((p) => p.movieId === movieId);
}

export function clearProgress(movieId: string): void {
  write(KEYS.progress, getProgress().filter((p) => p.movieId !== movieId));
}

/* ---------------- recent rooms ---------------- */

export interface RecentRoom {
  code: string;
  label?: string;
  at: number;
}

export function getRecentRooms(): RecentRoom[] {
  return read<RecentRoom[]>(KEYS.recentRooms, []);
}

export function rememberRoom(code: string, label?: string): void {
  const all = getRecentRooms().filter((r) => r.code !== code);
  write(KEYS.recentRooms, [{ code, label, at: Date.now() }, ...all].slice(0, 8));
}

/* ---------------- app settings ---------------- */

export interface AppSettings {
  highContrast: boolean;
  reduceEffects: boolean;
  chatSounds: boolean;
  autoSync: boolean;
  syncTolerance: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  highContrast: false,
  reduceEffects: false,
  chatSounds: true,
  autoSync: true,
  syncTolerance: 0.4,
};

export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...read<Partial<AppSettings>>(KEYS.settings, {}) };
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  write(KEYS.settings, next);
  applySettings(next);
  return next;
}

export function applySettings(settings: AppSettings): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.contrast = settings.highContrast ? 'high' : 'normal';
  document.documentElement.dataset.effects = settings.reduceEffects ? 'reduced' : 'full';
}
