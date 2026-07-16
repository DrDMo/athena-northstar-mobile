/**
 * Assignment picker — a small `Alert`-based chooser, mirroring the
 * Inbox's "File to assignment" flow (`inbox.tsx`). Used by the field
 * capture screens (text note, MLS scan) so a note can be filed to an
 * assignment at capture time. If the user has no assignments yet, or
 * taps "Inbox / skip", the capture stays unfiled (the tenant inbox)
 * and can be triaged later.
 *
 * Returns the chosen assignment id, or `null` for inbox/skip. Rejects
 * only if listing assignments fails — the caller decides whether that's
 * fatal (it usually isn't: capture to the inbox and move on).
 */

import { Alert } from 'react-native';

import {
  assignmentPickerLabel,
  listAssignments,
  type AssignmentSummary,
} from './api';

/**
 * Present the picker and resolve with the selected assignment id, or
 * `null` if the user chose to leave it in the inbox.
 */
export function pickAssignment(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    listAssignments()
      .then((assignments: AssignmentSummary[]) => {
        if (assignments.length === 0) {
          // Nothing to file to — go straight to the inbox.
          resolve(null);
          return;
        }
        const buttons = assignments.slice(0, 8).map((a) => ({
          text: assignmentPickerLabel(a),
          onPress: () => resolve(a.id),
        }));
        Alert.alert(
          'File to assignment',
          'Pick one, or keep it in your inbox.',
          [
            ...buttons,
            {
              text: 'Keep in inbox',
              style: 'cancel',
              onPress: () => resolve(null),
            },
          ],
          // On Android the alert is dismissible (hardware back / tap
          // outside) WITHOUT firing any button's onPress. Without this,
          // a dismiss left the Promise pending forever and stranded the
          // awaiting capture screen with its Cancel/Close disabled. Make
          // dismiss resolve to null (keep-in-inbox) so there's always an
          // exit. `cancelable: true` is the RN default but stated here
          // so the onDismiss contract is explicit.
          { cancelable: true, onDismiss: () => resolve(null) },
        );
      })
      .catch(reject);
  });
}
