/**
 * Shared presentational helpers for captures.
 *
 * These three were byte-identical across the Inbox, the capture detail,
 * and the assignment detail screens — extracted here so there's one
 * source of truth for the emoji icon, the human label, and the
 * relative-time string. Import from `@/lib/captureLabels`.
 */

import type { CaptureSummary } from './api';

/** Emoji glyph stand-in for a capture kind (used when there's no thumb). */
export function iconFor(kind: CaptureSummary['kind']): string {
  switch (kind) {
    case 'voice_note':
      return '🎙';
    case 'sketch':
      return '✏️';
    case 'text_note':
      return '📝';
    case 'photo':
    default:
      return '📷';
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
