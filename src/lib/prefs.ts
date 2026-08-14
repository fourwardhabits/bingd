import { sessionStorage } from './session-storage';

const key = (name: string) => `pref.${name}`;

export async function readPref<T>(name: string): Promise<T | null> {
  const raw = await sessionStorage.getItem(key(name));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writePref<T>(name: string, value: T): Promise<void> {
  await sessionStorage.setItem(key(name), JSON.stringify(value));
}

