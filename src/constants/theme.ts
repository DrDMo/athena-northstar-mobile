/**
 * North Star Appraisal — brand theme.
 *
 * Mirrors the cream + navy + warm-gold palette used across the
 * marketing site (athenadecisionsystems.com) and the web app
 * (appraisal.athenanorthstar.com) so the mobile surface feels
 * like one product.
 */

import { Platform } from 'react-native';

export const Brand = {
  // Backgrounds
  cream: '#f3ecdb',
  surface: '#fffaef',
  paperWarm: '#f7f0dc',

  // Ink (text)
  ink: '#1a1a1a',
  inkMuted: '#4a5568',
  inkFaint: '#8b97a8',

  // Brand mark
  navyDeep: '#0f1d3a',
  navySoft: '#163659',
  gold: '#b58c3a',
  goldSoft: '#c9a05a',

  // Structural
  border: '#e3dfd2',
  rule: '#cbc4ad',

  // Semantic
  green: '#1f6b3a',
  red: '#8a1f1f',
  amber: '#8a5a00',
} as const;

export const Colors = {
  light: {
    text: Brand.ink,
    background: Brand.cream,
    backgroundElement: Brand.surface,
    backgroundSelected: Brand.paperWarm,
    textSecondary: Brand.inkMuted,
    accent: Brand.gold,
    accentText: Brand.navyDeep,
    border: Brand.border,
  },
  dark: {
    // Dark mode uses inverse navy as background; gold stays the
    // accent so the brand feel survives. Keeping cream + navy
    // recognizable across modes.
    text: '#f3ecdb',
    background: '#0a1426',
    backgroundElement: '#163659',
    backgroundSelected: '#1f4c7a',
    textSecondary: '#b8c1d0',
    accent: Brand.gold,
    accentText: Brand.cream,
    border: '#2a3f5f',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    // Playfair Display, loaded at the root via @expo-google-fonts.
    // Matches the marketing site's serif headings so the brand voice
    // carries across surfaces.
    serif: 'PlayfairDisplay_700Bold',
    serifBook: 'PlayfairDisplay_400Regular',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'PlayfairDisplay_700Bold',
    serifBook: 'PlayfairDisplay_400Regular',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    serifBook: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;

export const Radius = {
  sm: 4,
  md: 8,
  lg: 14,
  pill: 999,
} as const;
