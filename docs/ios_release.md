# iOS Release: TestFlight, then the App Store

This guide takes the iPhone app, **Morph**, from nothing to TestFlight testers and then to the App Store. You don't need a Mac. You do the Apple setup in a browser and a Linux shell, and GitHub's macOS runner builds, signs and uploads the app.

The app is the Console as a client of a `morph console serve` running somewhere else, like the Android app. Users enter their server's address on the login page.

How the pieces fit:

| Piece | What it does |
| --- | --- |
| `web/console-nsh/scripts/build-ios.sh` | Builds `Morph.ipa` with `nsh package --target ios`, signed for the App Store, and checks the result. Runs on macOS only. |
| `.github/workflows/build_ios.yml` | Runs the script on `macos-15` and uploads the `.ipa` to TestFlight with Apple's `xcrun altool`. You can run it by hand. |
| `.github/workflows/release.yml` (job `ios-app`) | Calls `build_ios.yml` on every `v*` tag, with the tag as the version. |
| `web/console-nsh/ios/AppIcon-1024.png` | The App Store icon, opaque, from `design/brand/generator/platforms.py`. |

Before you start, check you have:

- [ ] A paid Apple Developer Program membership, with the **Account Holder** or **Admin** role
- [ ] A Linux shell with `openssl`, `curl` and `base64`
- [ ] The GitHub CLI (`gh`), logged in with access to `mistermorph`
- [ ] An iPhone with the **TestFlight** app installed from the App Store, for testing
- [ ] A `morph console serve` reachable over **https** that App Review can log in to (see Part 10)

## Part 1: Create the Apple Distribution certificate

An iOS app for TestFlight and the App Store is signed with an **Apple Distribution** certificate. The Developer ID certificate in [Apple Signing Setup on Linux](apple_signing_linux.md) is for Mac apps outside the App Store and can't sign an iOS app.

1. Make a private working folder:

   ```bash
   mkdir -p ~/ios-signing && cd ~/ios-signing && umask 077
   ```

2. Create a private key and a certificate signing request (CSR):

   ```bash
   openssl req -new -newkey rsa:2048 -nodes \
     -keyout distribution.key -out distribution.csr \
     -subj "/emailAddress=<your Apple ID email>/CN=<company name>/C=JP"
   ```

3. Open [developer.apple.com/account](https://developer.apple.com/account) → **Certificates, IDs & Profiles** → **Certificates** → **+**.
4. In the list of certificate types, select **Apple Distribution** and click **Continue**. If it isn't listed, **iOS Distribution (App Store Connect and Ad Hoc)** works the same for TestFlight and the App Store. If the options are greyed out, your role can't create distribution certificates; you need Account Holder or Admin.
5. Upload `distribution.csr`, click **Continue**, then **Download**. Save the file as `~/ios-signing/distribution.cer`.
6. Build the `.p12`. You'll be asked for an export password; save it, because it becomes `IOS_CERTIFICATE_PASSWORD`.

   ```bash
   curl -fsSLO https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
   openssl x509 -inform DER -in distribution.cer -out distribution.pem
   openssl x509 -inform DER -in AppleWWDRCAG3.cer -out AppleWWDRCAG3.pem
   # The two lines must match: the certificate belongs to your key.
   openssl x509 -in distribution.pem -noout -modulus | sha256sum
   openssl rsa -in distribution.key -noout -modulus | sha256sum
   openssl pkcs12 -export \
     -inkey distribution.key -in distribution.pem -certfile AppleWWDRCAG3.pem \
     -name "Apple Distribution" \
     -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
     -out Distribution.p12
   ```

   Keep the `-keypbe`, `-certpbe` and `-macalg` options. Without them, macOS can't import the `.p12` and the build fails with "MAC verification failed".

7. Print the identity name. This is `IOS_CODESIGN_IDENTITY`; copy it exactly, including the team ID in parentheses.

   ```bash
   openssl x509 -in distribution.pem -noout -subject -nameopt multiline,-esc_msb,utf8 | grep commonName
   ```

   It looks like `Apple Distribution: Example Inc (TEAMID1234)`, or `iPhone Distribution: Example Inc (TEAMID1234)` for an iOS Distribution certificate.

An Apple Distribution certificate lasts one year. Part 12 covers renewing it.

## Part 2: Register the App ID

1. Go to **Certificates, IDs & Profiles** → **Identifiers** → **+**.
2. Select **App IDs**, then **App**, and click **Continue**.
3. Fill in:
   - **Description**: `Morph`
   - **Bundle ID**: **Explicit**, `com.mistermorph.console` (the `id` in `web/console-nsh/nsh.json`)
   - **Capabilities**: leave them all off. The app uses none of them.
4. Click **Continue**, then **Register**.

## Part 3: Create the App Store provisioning profile

1. Go to **Certificates, IDs & Profiles** → **Profiles** → **+**.
2. Under **Distribution**, select **App Store Connect** and click **Continue**.
3. Choose the App ID `com.mistermorph.console`.
4. Choose the Apple Distribution certificate from Part 1.
5. Name it `Morph App Store`, click **Generate**, then **Download**. Save it as `~/ios-signing/Morph_App_Store.mobileprovision`.

A profile is tied to its certificate. When you renew the certificate, you also make a new profile.

## Part 4: Create the app in App Store Connect

1. Open [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Apps** → **+** → **New App**.
2. Fill in:
   - **Platforms**: iOS
   - **Name**: `Morph - AI Agent`, the name on the App Store page. It must be unique across the App Store; if Apple says it's taken, pick another. The name under the icon on the home screen is **Morph** either way, because it comes from the build.
   - **Primary Language**: English
   - **Bundle ID**: `com.mistermorph.console`
   - **SKU**: any internal ID, for example `mistermorph-ios`
   - **Company Name** (asked only when the team adds its first app): the developer name shown under the app's name on the App Store, for every app on the team. It must be unique across the App Store, so a short name such as "Arch" is likely taken; the legal name (`ARCH Inc. (Japan)`) usually isn't. You can't change it later in App Store Connect; only Apple Support can.
   - **User Access**: Full Access
3. Click **Create**.
4. Open **App Information** in the left column. Copy the **Apple ID** (a number such as `6739012345`). This is `IOS_APP_STORE_APP_ID`.

## Part 5: Check the App Store Connect API key

The upload uses the same API key as the macOS notarization: `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER_ID`, set up in [Apple Signing Setup on Linux](apple_signing_linux.md), Part 4. Nothing to do here unless the first upload is refused (Part 7). If it is, the key's role can't upload builds. In that case, generate a new team key with the **App Manager** role and set the three `APPLE_API_*` secrets to the new key.

## Part 6: Put the secrets into GitHub

From your `mistermorph` checkout:

```bash
base64 -w0 ~/ios-signing/Distribution.p12 | gh secret set IOS_CERTIFICATE_BASE64
gh secret set IOS_CERTIFICATE_PASSWORD
gh secret set IOS_CODESIGN_IDENTITY --body "Apple Distribution: Example Inc (TEAMID1234)"
base64 -w0 ~/ios-signing/Morph_App_Store.mobileprovision | gh secret set IOS_PROVISIONING_PROFILE_BASE64
gh secret set IOS_APP_STORE_APP_ID --body "6739012345"
gh secret list | grep -E 'IOS_|APPLE_API_'
```

You should see the five `IOS_*` secrets and the three `APPLE_API_*` secrets.

Store the files from `~/ios-signing` (the `.p12` and its password, `distribution.key`, the profile) in a password manager. Then remove the folder with `rm -rf ~/ios-signing`.

## Part 7: Build and upload the first build

Run the first build by hand instead of waiting for a release tag:

1. On GitHub, open **Actions** → **Build iOS App** → **Run workflow**.
2. Enter the **latest released version**, for example `0.3.118`, and leave **Upload to TestFlight** checked.

   The build number comes from the version (`0.3.118` is build 3118), and App Store Connect accepts each build number once. A released version is safe to reuse because its tag has already run. Don't enter the next version: the trial would take its build number, and that release's upload would then fail. A failed upload doesn't use up the number, so you can rerun the same version until one succeeds.

3. Click **Run workflow** and wait for the run to finish (a few minutes).
4. Read the **Build Morph.ipa** step's log. Any `warning:` line there matters; see "Known gaps" below.
5. The `.ipa` is also saved as the run's **Morph-ios** artifact, kept for 7 days.

After a successful upload, the build shows up in App Store Connect → your app → **TestFlight** as **Processing**. Processing usually takes 5–30 minutes. Apple emails you if it rejects the build.

From then on, each `v*` tag builds and uploads the iOS app automatically (the `ios-app` job in `release.yml`), alongside the Android app.

## Part 8: Test with your team (internal testing)

Internal testers are people on your App Store Connect team, up to 100. Their builds don't need review.

1. When the build finishes processing, App Store Connect may show **Missing Compliance**. Click **Manage**. The app only uses the system's standard encryption (HTTPS), so answer that it uses no encryption beyond what's exempt. You answer this once per build.
2. Go to **TestFlight** → **Internal Testing** → **+**, and create a group, for example `Team`.
3. Add testers. They have to be users under **Users and Access** first.
4. Open the group's **Builds** tab, click **+** and add the build.
5. Each tester gets an email. They open it on the iPhone, which opens TestFlight, and tap **Install**.

Check on a real iPhone, at least:

- [ ] Logging in to your server (see the http gap below)
- [ ] Chat, tasks and settings
- [ ] Voice input, if the build has the microphone text
- [ ] Rotating the phone, the keyboard, and the safe areas around the notch

## Part 9: Test with outsiders (external testing)

External testers are anyone, up to 10,000, by email invite or a public link. The first build of each version goes through a short **Beta App Review**, usually within a day.

1. Open **TestFlight** → **Test Information** and fill in:
   - **Beta App Description**: what the app is and that it needs a Mister Morph server
   - **Feedback Email**
   - **Privacy Policy URL**
2. Under **Beta App Review Information**, fill in a contact and the **sign-in information**: your demo server's address and a working login (Part 10). Without these, the review is rejected.
3. Go to **External Testing** → **+**, and create a group, for example `Beta`.
4. Add the build to the group. App Store Connect asks **What to Test**; describe what the testers should look at, then click **Submit for Review**.
5. When it's approved, add testers by email, or turn on **Public Link** and share the link.

TestFlight builds expire after 90 days. A new tag makes a new build; add it to the groups to keep testers current.

## Part 10: Prepare for App Review

App Review has to use the app the way a user would. Because Morph is a client of a server, set up a server they can reach:

- A `morph console serve` on **https**, with a public address (not a LAN address)
- An account for the reviewer, with a model configured so chat answers
- Keep it running until the review is done, and through each later review

Without this, the review fails under Guideline 2.1 (App Completeness), because the reviewer can't get past the login page.

## Part 11: Submit to the App Store

1. In App Store Connect, open your app → **App Store** tab. The first version, **1.0 Prepare for Submission**, is already there. Rename it to your release version, such as `0.3.80`, so it matches the build.
2. **Screenshots**: upload iPhone screenshots at 6.9-inch (1320 × 2868) or 6.5-inch (1284 × 2778) size; the page lists the sizes it accepts. Without a Mac, take them on an iPhone running the TestFlight build. A Pro Max model gives the 6.9-inch size directly. If the build also runs on iPad, App Store Connect asks for 13-inch iPad screenshots too.
3. Fill in **Promotional Text** (optional), **Description**, **Keywords**, **Support URL** and **Marketing URL** (optional).
4. **Build**: click **+** next to **Build** and pick the TestFlight build you tested.
5. **App Review Information**: the same sign-in details as in Part 9 (server address, username, password). In **Notes**, explain that the app is a client for a self-hosted Mister Morph server, and that the demo server is provided for review. Also say why it allows plain http (`NSAllowsArbitraryLoads`): users run the server themselves, often on their own local network at an address of their choosing, and `morph console serve` serves plain http unless they put it behind a TLS proxy. App Review asks for this reason.
6. **Version Release**: choose **Manually release this version** for the first time, so you control the launch day.
7. In the left column, fill in:
   - **App Information**: category (Productivity or Developer Tools), content rights, **age rating** questionnaire
   - **Pricing and Availability**: price (Free) and countries
   - **Business** (top bar) → **Trader status**: declare it for the EU's Digital Services Act, or the app isn't offered in EU countries. A company is a trader, and its address and contact details are shown on the EU App Store.
   - **App Privacy**: privacy policy URL, and the data the app collects. The app sends what users type to the user's own server, not to you; answer to match your privacy policy.
8. Click **Add for Review**, then **Submit to App Review**.

Review usually takes 1–2 days. If it's rejected, the message names the guideline. Answer in **Resolution Center**, or fix the problem, upload a new build (new tag) and resubmit.

When it's approved, click **Release This Version** (if you chose manual release). The app shows up on the App Store within about a day.

## Part 12: Each later release

1. Push the `v*` tag as usual. The `ios-app` job builds the app with the tag's version and uploads it to TestFlight.
2. In App Store Connect, answer **Missing Compliance** for the new build.
3. Add the build to the TestFlight groups and test it.
4. On the **App Store** tab, click **+** next to **iOS App**, enter the new version, pick the build, write **What's New in This Version**, and submit it for review.

Renewals:

| Item | When | How |
| --- | --- | --- |
| Apple Distribution certificate | Before it expires (one year) | Repeat Parts 1 and 3, then set `IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD`, `IOS_CODESIGN_IDENTITY` and `IOS_PROVISIONING_PROFILE_BASE64` again. An expired certificate doesn't affect the app already on the App Store. |
| Provisioning profile | With the certificate, or when it expires | Repeat Part 3 and set `IOS_PROVISIONING_PROFILE_BASE64` |
| Developer Program membership | Every year | If it lapses, the app is removed from the App Store and TestFlight stops |

## Known gaps

The iOS app had never been built when this guide was written. These might show up on the first TestFlight build:

- **Plain `http://` servers**: `morph console serve` has no TLS of its own, so a server reached directly on the local network is plain http, which iOS blocks by default (App Transport Security). `web/console-nsh/nsh.json` turns that off (`ios.infoPlist`: `NSAllowsArbitraryLoads`), with `NSLocalNetworkUsageDescription` for the local network prompt iOS shows on the first LAN connection. If the build prints `warning: Info.plist allows no plain http://`, nsh dropped that setting.
- **Microphone text**: if the build prints `warning: Info.plist has no NSMicrophoneUsageDescription`, App Store Connect may reject the upload with ITMS-90683, and voice input can't ask for the microphone.
- **Features from the Android app's own code**: voice recording, task notifications and saving files come from the Android app's Java (`web/console-nsh/android/src`), and iOS has nothing in their place. On iOS, saving files says it's unavailable and there are no task notifications.
- **Shell version**: Settings → System → Updates shows the iOS app's version as Unknown (see [App](app.md)).

## Troubleshooting

| Message | Where | Cause | Fix |
| --- | --- | --- | --- |
| `IOS_… not set: no iOS app` | Workflow warning | Secrets missing | Part 6 |
| `MAC verification failed during PKCS12 import` | Set up iOS signing | Wrong `.p12` password, or the `.p12` was built without the three compatibility options | Rebuild it as in Part 1, step 6 |
| `APPLE_CODESIGN_IDENTITY is not in the imported certificate` | Set up iOS signing | `IOS_CODESIGN_IDENTITY` doesn't match the certificate | Copy it again from Part 1, step 7 |
| `No profile matching` / profile errors from `nsh package` | Build Morph.ipa | The profile isn't for this App ID or certificate, or it expired | Make a new profile (Part 3) |
| `the app is labelled '…', not Morph` | Build Morph.ipa | nsh didn't apply `--name` | Report it against nsh; the build stops before uploading |
| 401 / 403, or "Authentication failed", from `altool` | Upload to TestFlight | Wrong key ID or issuer ID, or the key's role can't upload builds | Part 5 |
| "The bundle version must be higher than the previously uploaded version" | Upload to TestFlight | That version and build number was already uploaded | Use a new version (Part 7, step 2) |
| ITMS-90683 "Missing purpose string" | Email from Apple | No `NSMicrophoneUsageDescription` | See Known gaps |
| ITMS-90717 "Invalid App Store Icon" | Email from Apple | The icon has an alpha channel | Regenerate `ios/AppIcon-1024.png`; the script refuses an icon with alpha |
