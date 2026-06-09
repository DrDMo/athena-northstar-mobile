# Installing North Star ^Appraiser on a real device

This walks you (Darin) through getting a real APK / IPA you can install on a phone for review. We use EAS Build — Expo's hosted build cloud — so you don't need to install Android Studio or Xcode locally.

## One-time setup

1. **Create an Expo account** (free): <https://expo.dev/signup>
2. **Install EAS CLI** locally:
   ```bash
   npm install -g eas-cli
   ```
3. **Log in** from this repo:
   ```bash
   cd "c:/Users/darin/Documents/_Athena Decision System/athena-northstar-mobile"
   eas login
   ```
4. **Initialize the EAS project** (first time only — links the local repo to a remote project id):
   ```bash
   eas init --non-interactive
   ```
   This writes the project id into `app.json` → `expo.extra.eas.projectId`. Commit that change.

## Android — fastest path

EAS handles the Android keystore for you on first build (it offers to generate one). You don't need a Google Play Console account to get an APK you can install.

```bash
npm run build:android:preview
```

Wait ~10-15 minutes. The CLI shows a URL with the build progress + final download link. When it's done:

1. On the Android phone, open the URL (or get it via email)
2. Tap "Install"
3. If Android complains about unknown sources, tap Settings → allow this browser to install apps → re-tap Install

That's it — fully functional app on the device, talking to `appraisal.athenanorthstar.com`.

## iOS — needs a paid Apple Developer account

iOS sideloading without TestFlight requires:
- Paid Apple Developer Program membership ($99/yr) — sign up at <https://developer.apple.com/programs/>
- The test device's UDID registered in your developer account (EAS prompts you for it)

Once those are in place:

```bash
npm run build:ios:preview
```

Same wait, same workflow — open the link on the device, install. Profile expires after 7 days for personal accounts (free), 1 year for paid; renew by re-running the build.

If you want to skip the Apple Developer fee for now: **TestFlight via a free developer account** lets you install on your own device only, but the build process is the same EAS Build call. Or stick with Android until paid Apple is justified.

## Both at once

```bash
npm run build:all:preview
```

## After the first build

Subsequent builds are cached for the unchanged parts of the JS bundle, so they're faster (~5-8 min). Every push to `main` doesn't auto-build — you trigger a build manually when you want a new APK / IPA.

## Submitting to stores (later)

When the app is ready for the App Store + Play Store:

```bash
eas build --platform all --profile production
eas submit --platform android --latest
eas submit --platform ios --latest
```

The `submit` step needs Apple App Store Connect + Google Play Console credentials configured first; see `eas.json` → `submit.production` placeholders.

## Cost

EAS Build is **free** for accounts under 30 builds/month on the free tier (we're nowhere near that). The Apple Developer fee ($99/yr) is the only paid item, and only for iOS.
