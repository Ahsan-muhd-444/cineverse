'use client';

import { useEffect } from 'react';
import { applySettings, getSettings } from '@/lib/storage';

/** Applies stored accessibility preferences as early as the client can run. */
export function SettingsBoot() {
  useEffect(() => {
    applySettings(getSettings());
  }, []);
  return null;
}
