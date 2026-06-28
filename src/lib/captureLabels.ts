/**
 * Shared presentational helpers for captures.
 *
 * These three were byte-identical across the Inbox, the capture detail,
 * and the assignment detail screens — extracted here so there's one
 * source of truth for the emoji icon, the human label, and the
 * relative-time string. Import from `@/lib/captureLabels`.
 */

import type { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

import type { CaptureSummary } from './api';

/**
 * Ionicons glyph name for a capture kind (used when there's no thumb).
 *
 * #517: was an emoji stand-in (🎙/✏️/📝/📷), which rendered as tofu
 * boxes on Android with no system emoji font. Now returns an Ionicons
 * name the caller renders with `<Ionicons name={iconFor(kind)} … />`.
 */
export function iconFor(
  kind: CaptureSummary['kind'],
): ComponentProps<typeof Ionicons>['name'] {
  switch (kind) {
    case 'voice_note':
      return 'mic';
    case 'sketch':
      return 'pencil';
    case 'text_note':
      return 'document-text';
    case 'photo':
    default:
      return 'camera';
  }
}

/** Human-readable label for a capture kind. */
export function labelFor(kind: CaptureSummary['kind']): string {
  switch (kind) {
    case 'voice_note':
      return 'Voice note';
    case 'sketch':
      return 'Sketch';
    case 'text_note':
      return 'Text note';
    case 'photo':
    default:
      return 'Photo';
  }
}

/** Short relative-time string ("just now", "5m ago", …) from an ISO date. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604_800) return `${Math.floor(diffSec / 86_400)}d ago`;
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}
