import { type Language } from '../types/metadata';

// Per-flow Cartesia voice IDs. Each flow gets its own table so the voice
// of one agent (e.g. onboarding clinician) can be tuned independently of
// another (e.g. qualification intake) without affecting siblings.
//
// Mirrors tracking-agent's choice
// (samwise-backend/tracking-agent/src/main.ts:33).

export const QUALIFICATION_VOICE_ID_BY_LANGUAGE: Record<Language, string> = {
  en: '5ee9feff-1265-424a-9d7f-8e4d431a12c7', // English-Male
  es: '13ff5deb-2591-42ad-a356-63a04e524411',
};

export const ONBOARDING_VOICE_ID_BY_LANGUAGE: Record<Language, string> = {
  en: '5ee9feff-1265-424a-9d7f-8e4d431a12c7', // English-Male
  es: '13ff5deb-2591-42ad-a356-63a04e524411',
};

export const DEFAULT_RITUAL_CALL_VOICE_ID = '03496517-369a-4db1-8236-3d3ae459ddf7';
