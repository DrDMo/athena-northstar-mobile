# Alpha test — Sunday, June 14, 2026

A walk-through for Darin + Justin. Do these in order. After each one,
note whether it worked. If anything breaks, file a bug (see the
bottom of this page).

The goal isn't to be gentle — push on it. The point of an alpha is
to find what breaks before customers do.

---

## Before you start

- [ ] Install the app (Android: tap the download link we emailed; iOS:
      accept the TestFlight invite).
- [ ] Have your North Star login ready (the same email + password you
      use on appraisal.athenanorthstar.com).
- [ ] Make sure you have at least one assignment created on the
      website first — the mobile app reads from the same account.

---

## Part 1 — Getting in

1. [ ] Open the app. Does the branded login screen appear (cream
       background, gold "North Star" wordmark)?
2. [ ] Sign in. Does it land you on the Assignments tab?
3. [ ] Close the app fully (swipe it away). Reopen it. Are you still
       signed in? (You should be — no second login.)

## Part 2 — Looking around

4. [ ] Tap each of the five tabs: Assignments, Capture, Inbox,
       Reference, Settings. Do they all open without crashing?
5. [ ] On Assignments, do you see the assignments from your account?
6. [ ] Tap an assignment. Does the detail screen open?

## Part 3 — Taking photos

7. [ ] Tap Capture → Photo. Grant camera + location when asked.
8. [ ] Take 3 photos. Do they appear as thumbnails at the bottom?
9. [ ] Do the thumbnails show a green "GPS" badge?
10. [ ] Tap the X to close. No crash?

## Part 4 — Voice notes

11. [ ] Tap Capture → Voice note. Grant microphone when asked.
12. [ ] Record a 10-second note. Does the timer count up?
13. [ ] Stop it. Does the "saved" pill appear?

## Part 5 — The offline test (the important one)

14. [ ] Turn on Airplane mode.
15. [ ] Take 2 photos and record 1 voice note.
16. [ ] Open Settings. Does the Capture Queue show items "pending"?
17. [ ] Turn Airplane mode off.
18. [ ] Wait 30 seconds, then open Settings again. Did the pending
        count drop and "synced" go up? (Or tap "Sync now" to force it.)

## Part 6 — Filing

19. [ ] Tap the Inbox tab. Do your synced photos + voice notes appear?
20. [ ] Tap File on a photo. Pick an assignment. Does the row
        disappear?
21. [ ] Open that assignment on the website. Is the photo there?

## Part 7 — Transcription

22. [ ] Open one of your voice notes (in the Inbox or under the
        assignment).
23. [ ] Is there a typed version of what you said? (It may take up to
        a minute — pull down to refresh.)
24. [ ] Is the transcription roughly accurate?

## Part 8 — Looking up a rule

25. [ ] Tap Reference. Type "effective date" in the search box.
26. [ ] Do results appear?
27. [ ] Tap one. Does it expand to show the citation + details?
28. [ ] Tap the source link. Does it open the rule online?

## Part 9 — Signing out

29. [ ] Settings → Sign out. Does it return you to the login screen?
30. [ ] Sign back in. Is everything still there?

---

## Found a bug?

File it here:
[github.com/DrDMo/athena-northstar-mobile/issues/new/choose](https://github.com/DrDMo/athena-northstar-mobile/issues/new/choose)

Pick "Alpha bug report" and fill in what you can. A rough note beats
no note. Screenshots help a lot.

Or just email it to hello@athenadecisionsystems.com and we'll log it.

## The honest list of what's NOT done yet

So you don't report these as bugs — they're known gaps:

- **Sketch capture** — the Sketch tile says "SOON". Not built yet.
- **MLS scan** — also "SOON".
- **Text note** — also "SOON".
- **Creating a workfile from the phone** — do that on the website
  for now; the phone is read-only on workfiles.
- **The Agent** — separate desktop app, not part of this mobile test.
- **Background sync on some Android phones** — Samsung/Xiaomi
  battery savers may stop auto-sync; use "Sync now" if so.
