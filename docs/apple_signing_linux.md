# Apple Signing Setup on Linux

You need two things from Apple, a Developer ID certificate and an App Store Connect API key, which become six GitHub secrets. All of it can be done on Linux. GitHub's macOS runner does the actual signing and notarizing during each tagged release.

The release workflow uses these secrets to sign and notarize the `morph` CLI in the darwin archives and the MrMorph desktop DMG. Signed and notarized builds open without the "developer cannot be verified" warning. How the workflow uses them is described in [OS Signing](os_signing.md).

| Secret | What it is | Where it comes from |
| --- | --- | --- |
| `APPLE_CERTIFICATE_BASE64` | The certificate and its private key, as a base64 `.p12` | Parts 1–3 |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set on the `.p12` | Part 3 |
| `APPLE_CODESIGN_IDENTITY` | The certificate's name, for example `Developer ID Application: Example Inc (TEAMID1234)` | Part 3 |
| `APPLE_API_KEY_BASE64` | The App Store Connect API key, as a base64 `.p8` | Part 4 |
| `APPLE_API_KEY_ID` | The key's ID, 10 characters | Part 4 |
| `APPLE_API_ISSUER_ID` | Your team's issuer ID, a UUID | Part 4 |

Before you start, check you have:

- [ ] A paid Apple Developer Program membership
- [ ] The **Account Holder** role on the team. Only the Account Holder can create a Developer ID certificate.
- [ ] A Linux shell with `openssl`, `curl` and `base64`
- [ ] The GitHub CLI (`gh`), logged in with access to `mistermorph` and `mistermorph-pro`

## Part 1: Create a private key and a signing request

You make the private key yourself and send Apple only a certificate signing request (CSR). Apple never sees the private key.

1. Make a private working folder. `umask 077` makes the new files readable only by you.

   ```bash
   mkdir -p ~/apple-signing && cd ~/apple-signing && umask 077
   ```

2. Create the key and the CSR. Put your Apple ID email in `emailAddress`, and replace `<company name>` with your company's name in English letters, as registered with Apple. `C=JP` is the country code for Japan; use your own country's code if it differs. Apple puts your team's registered name in the final certificate, so these fields only need to be sensible.

   ```bash
   openssl req -new -newkey rsa:2048 -nodes \
     -keyout developer_id.key -out developer_id.csr \
     -subj "/emailAddress=<your Apple ID email>/CN=<company name>/C=JP"
   ```

3. Check you now have two files: `developer_id.key` (the private key) and `developer_id.csr` (the request).

`developer_id.key` is the most sensitive file in this guide. Anyone who has it and the certificate can sign software as your team. Don't email it, commit it or paste it anywhere.

## Part 2: Get the Developer ID certificate from Apple

Apple signs your request and gives back a `.cer` file. This happens in the browser.

1. Open [developer.apple.com/account](https://developer.apple.com/account) and sign in with the Account Holder's Apple ID. If you belong to several teams, pick the right team in the top-right menu.
2. Under **Certificates, IDs & Profiles**, click **Certificates**.
3. Click the **+** button next to the "Certificates" heading.
4. In the **Software** section, select **Developer ID Application** and click **Continue**. Don't pick "Developer ID Installer" (that one is for `.pkg` installers) or "Apple Distribution" (that one is for the App Store).
5. For **Profile Type**, choose **G2 Sub-CA (Xcode 11.4.1 or later)**, not "Previous Sub-CA".
6. Click **Choose File**, select `developer_id.csr` from Part 1, then click **Continue**.
7. Click **Download**. Save the file into `~/apple-signing` as `developer_id.cer`.

The certificate is valid for five years. A team can only have a few Developer ID Application certificates at once. If Apple says you've reached the limit, the old one is still active; read Part 7 before you revoke anything.

## Part 3: Build the .p12 and find the identity name

The `.p12` bundles your certificate, your private key and Apple's intermediate certificate into one password-protected file. That's the form the macOS runner can import.

1. Download Apple's Developer ID intermediate certificate:

   ```bash
   cd ~/apple-signing
   curl -fsSLO https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
   ```

2. Convert both certificates from Apple's binary format (DER) to text (PEM):

   ```bash
   openssl x509 -inform DER -in developer_id.cer -out developer_id.pem
   openssl x509 -inform DER -in DeveloperIDG2CA.cer -out DeveloperIDG2CA.pem
   ```

   If the first command fails with "could not read certificate", the download is already PEM. Run `cp developer_id.cer developer_id.pem` instead.

3. Check the certificate belongs to your private key. The two lines must be identical:

   ```bash
   openssl x509 -in developer_id.pem -noout -modulus | sha256sum
   openssl rsa -in developer_id.key -noout -modulus | sha256sum
   ```

4. Build the `.p12`. OpenSSL asks for an export password twice; choose a long one and save it. That password is `APPLE_CERTIFICATE_PASSWORD`.

   ```bash
   openssl pkcs12 -export \
     -inkey developer_id.key -in developer_id.pem -certfile DeveloperIDG2CA.pem \
     -name "Developer ID Application" \
     -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
     -out DeveloperID.p12
   ```

   Keep the `-keypbe`, `-certpbe` and `-macalg` options. Without them, OpenSSL 3 uses an encryption that the macOS `security import` command can't read, and the release fails with "MAC verification failed".

5. Check the `.p12` opens with your password and holds a key and two certificates:

   ```bash
   openssl pkcs12 -in DeveloperID.p12 -noout -info
   ```

6. Print the identity name:

   ```bash
   openssl x509 -in developer_id.pem -noout -subject -nameopt multiline,-esc_msb,utf8 | grep commonName
   ```

   The value after `commonName =` is `APPLE_CODESIGN_IDENTITY`, for example `Developer ID Application: Example Inc (TEAMID1234)`. Copy it exactly, including the team ID in parentheses.

## Part 4: Create the App Store Connect API key

The API key lets the release workflow submit builds to Apple's notary service. It belongs to the team, not to one person's Apple ID, so it keeps working when passwords or people change.

1. Open [appstoreconnect.apple.com](https://appstoreconnect.apple.com) and sign in with the same team.
2. Click **Users and Access**, then the **Integrations** tab, then **App Store Connect API** in the left column.
3. Select the **Team Keys** tab. If you see **Request Access** instead of a key list, the Account Holder has to click it and accept the terms first; this is a one-time step.
4. Click **Generate API Key**, or the **+** button if keys already exist.
5. Name it, for example `mistermorph-notarize`. Under **Access**, choose **Developer**. That role is enough for notarization; don't give it Admin.
6. Click **Generate**.
7. In the key's row, click **Download API Key**. Save it into `~/apple-signing`. The file is named `AuthKey_<KEY ID>.p8`.
8. Write down two values from the same page:
   - **Key ID**: the 10-character value in the key's row, also in the file name. This is `APPLE_API_KEY_ID`.
   - **Issuer ID**: the UUID shown above the key list. This is `APPLE_API_ISSUER_ID`.

Apple lets you download a key only once. If you lose the `.p8`, revoke that key and create a new one.

## Part 5: Put the secrets into GitHub

Set all six secrets in both repositories. The release workflow reads them on every tag.

1. Go to your `mistermorph` checkout and set the secrets. Replace the example values with yours. The commands without `--body` prompt for the value, so the password and IDs stay out of your shell history.

   ```bash
   cd path/to/mistermorph
   base64 -w0 ~/apple-signing/DeveloperID.p12 | gh secret set APPLE_CERTIFICATE_BASE64
   gh secret set APPLE_CERTIFICATE_PASSWORD
   gh secret set APPLE_CODESIGN_IDENTITY --body "Developer ID Application: Example Inc (TEAMID1234)"
   base64 -w0 ~/apple-signing/AuthKey_ABCD123456.p8 | gh secret set APPLE_API_KEY_BASE64
   gh secret set APPLE_API_KEY_ID
   gh secret set APPLE_API_ISSUER_ID
   ```

2. Do the same in `mistermorph-pro`: run the same commands from its checkout, or add `--repo <owner>/mistermorph-pro` to each `gh secret set`.
3. Check the list in each repository. You should see all six names:

   ```bash
   gh secret list | grep APPLE_
   ```

4. Releases made before the switch to the API key used `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD`. Once a release with the current workflow passes, delete them in both repositories:

   ```bash
   gh secret delete APPLE_ID
   gh secret delete APPLE_TEAM_ID
   gh secret delete APPLE_APP_PASSWORD
   ```

## Part 6: Check the release

Notarization only runs on Apple's side, so the first tag after setting the secrets is the real test. If a secret is wrong, the CLI job stops before it publishes anything, so a failed run costs only a new tag. The desktop job runs after the CLI is published, so if only that job fails, the release is out without the DMG.

1. Push the tag and watch the run: `gh run watch`.
2. In the **goreleaser** job, find the hook output for each darwin binary. A good run shows `notarization <id>: Accepted` twice, once for amd64 and once for arm64.
3. The **Build Desktop App (macos-arm64)** job should show `Accepted` for the DMG, followed by the stapler messages.

If a step fails, match its message here:

| Message in the log | Cause | Fix |
| --- | --- | --- |
| `Missing required macOS signing settings` followed by names | Those secrets are empty or misspelled | Set the listed secrets (Part 5) |
| `MAC verification failed during PKCS12 import` | Wrong `.p12` password, or the `.p12` was built without the three compatibility options | Rebuild the `.p12` exactly as in Part 3, step 4, and set both secrets again |
| `APPLE_CODESIGN_IDENTITY is not in the imported certificate` | The identity text doesn't match the certificate, or the `.p12` has no private key | Copy the name again from Part 3, step 6; check step 3's two lines match |
| `notarytool` reports 401 or "Unable to authenticate" | Wrong key ID or issuer ID, a broken `.p8` upload, or a revoked key | Check both IDs on the App Store Connect page; set `APPLE_API_KEY_BASE64` again |
| `notarization <id>: Invalid` followed by a JSON log | Apple rejected the binary | The log names the file and the reason; see the troubleshooting notes in [OS Signing](os_signing.md) |

To check a released CLI binary without a Mac, use [rcodesign](https://github.com/indygreg/apple-platform-rs), which runs on Linux: `rcodesign print-signature-info morph`. It should name your Developer ID certificate. Gatekeeper's own check (`spctl --assess`) needs a Mac.

## Part 7: Store the files and replace them later

GitHub secrets can't be read back, so keep your own copy of the files in a password manager. Then delete them from disk.

1. Store these in a password manager entry, for example "Apple signing":
   - `DeveloperID.p12` and its password
   - `developer_id.key` (only needed to rebuild the `.p12`)
   - `AuthKey_<KEY ID>.p8`, the key ID and the issuer ID
   - The identity name and the certificate's expiry date (five years from Part 2)
2. Delete the working folder: `rm -rf ~/apple-signing`.

When to replace what:

| Item | When | How |
| --- | --- | --- |
| Developer ID certificate | A few weeks before it expires, or right away if the private key leaked | Repeat Parts 1–3 and set the three certificate secrets. Let the old certificate expire on its own. |
| API key | If the `.p8` leaked or was lost, or when you choose to rotate it | Repeat Part 4, set the three key secrets, then revoke the old key in App Store Connect |
| Old Apple ID app-specific password | After the first release that notarizes with the API key passes | Revoke it at [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords |

Don't revoke a Developer ID certificate unless its private key has leaked. Revoking it can stop macOS from opening software already signed with it, including releases already on users' machines. If it has leaked, revoke it and contact Apple Developer Support about the revocation date.
