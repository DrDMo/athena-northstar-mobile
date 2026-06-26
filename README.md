# North Star Appraisal — Mobile

The field companion to **Athena Systems North Star Appraisal**. Lets an
appraiser work an assignment from the property itself — pull up the
workfile, capture photos with GPS + timestamp baked in, dictate notes,
sketch sites, and sync everything back into the sealed audit chain
served by the web app.

The mobile app is one of three coordinated surfaces:

| Surface       | Where it lives                                |
|---------------|-----------------------------------------------|
| Marketing     | <https://athenadecisionsystems.com>           |
| Product (web) | <https://appraisal.athenanorthstar.com>       |
| Product (iOS) | TestFlight, then App Store                    |

It talks to the same backend the web app does — no separate mobile API.

## Stack

- [Expo SDK 56](https://docs.expo.dev/) + [React Native 0.85](https://reactnative.dev/)
- [Expo Router](https://docs.expo.dev/router/introduction) for file-based routing
- [`expo-secure-store`](https://docs.expo.dev/versions/latest/sdk/securestore/) for session-token persistence (iOS Keychain / Android Keystore)
- TypeScript strict mode

Auth is cookie-based, matching the web app: log in once via
`POST /v1/auth/sessions`, capture the `Set-Cookie: session=…` value,
and attach it to every subsequent request as a `Cookie:` header.

## Layout

```
src/
  app/                            # expo-router file-based routes
    _layout.tsx                   # root layout + auth gate
    login.tsx                     # /login
    (authed)/
      _layout.tsx                 # tabs: Assignments | Capture | Settings
      index.tsx                   # /  (assignments list)
      capture.tsx                 # /capture (quick actions grid)
      settings.tsx                # /settings (account + sign out)
      assignments/
        [id].tsx                  # /assignments/:id
  components/                     # cross-screen shared bits (kept thin)
  constants/
    theme.ts                      # brand palette, spacing, radius, fonts
  hooks/                          # custom react hooks
  lib/
    api.ts                        # backend client (login, fetchMe, listAssignments, …)
    session.ts                    # SecureStore wrapper
assets/                           # icons, splash, fonts
```

The `(authed)` group keeps any route requiring a session inside one
folder so the root `_layout.tsx` can gate everything in a single
place: if `fetchMe()` returns `null`, redirect to `/login`.

## Brand

Same cream + navy + warm-gold palette as the marketing site and web
app. Colour and spacing tokens live in `src/constants/theme.ts` —
edit there, never inline.

The wordmark renders as:

```
ATHENA SYSTEMS         (eyebrow, gold, uppercase, tracked)
North Star             (Playfair Display serif, navy)
Appraiser · Field      (gold descriptor)
```

## Local dev

```bash
npm install
npm run ios           # iOS simulator (requires macOS + Xcode)
npm run android       # Android emulator
npm run web           # quick browser preview (limited; native APIs absent)
```

By default the app talks to **`https://appraisal.athenanorthstar.com`**.
To point at a local backend during development, edit `app.json` and
set `expo.extra.apiBase` to your dev API URL:

```jsonc
"extra": {
  "apiBase": "http://localhost:8080"
}
```

Cookies on `http://localhost` need `SameSite=Lax` and no `Secure`
flag; the decision-server emits those when running in dev mode.

## API surface used so far

| Endpoint                         | Used by                          |
|----------------------------------|----------------------------------|
| `POST /v1/auth/sessions`         | `login()` — `src/lib/api.ts`     |
| `DELETE /v1/auth/sessions`       | `logout()`                       |
| `GET /v1/auth/me`                | `fetchMe()` (root auth gate)     |
| `GET /v1/cases`                  | `listAssignments()`              |
| `GET /v1/cases/:id`              | `getAssignment()`                |
| `POST /v1/cases`                 | `createAssignment()` (not wired) |

All endpoint shapes are kept grep-compatible with the web app's
`web/src/lib/api.ts` so future refactors hit both surfaces.

## Roadmap

| Milestone | Scope                                                                 | Status   |
|-----------|-----------------------------------------------------------------------|----------|
| m0        | Scaffold: Expo SDK 56, bundle ID, theme tokens                         | done     |
| m1        | Login screen + cookie-session client                                   | done     |
| m2        | Authed tab group: Assignments / Capture / Settings                     | done     |
| m3        | Native photo capture (EXIF + GPS preserved)                            | next     |
| m4        | Voice note capture (`.m4a`, transcribed server-side)                   | next     |
| m5        | Sketch capture (gesture canvas → SVG → workfile attachment)            | later    |
| m6        | Offline queue + sync (work in dead-zone properties without signal)     | later    |
| m7        | MLS barcode scan                                                       | later    |
| m8        | Apple Pencil + iPad layout                                             | later    |

The "later" items wait until we have field-testing signal from real
appraisers using m0–m4 so we don't gold-plate things that don't
matter to the workflow.

## Conventions

Mirrors the parent monorepo:

- Branches: `m<NN>-<slug>` off `main`
- Commits: signed; protected `main`
- CI gates: `tsc --noEmit` + `expo lint` (will be added once
  pushed to GitHub)
- No time estimates in roadmap / planning docs
- Real photos used for testing must have PII (faces, plates,
  street numbers) blurred before they land in the repo
