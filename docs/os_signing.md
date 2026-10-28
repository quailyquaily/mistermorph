# OS Signing

This document describes release signing for desktop and CLI builds distributed outside app stores.

Signing does not make a build safe by itself. It gives the operating system a publisher identity, protects the artifact from unnoticed modification, and lets OS reputation systems make a better decision.

## Release Assets

The tag release workflow builds these desktop assets:

- macOS: `MrMorph-darwin-arm64.dmg`
- Windows: `MrMorph-windows-amd64.zip`
- Linux: `MrMorph-linux-amd64.AppImage` and `MrMorph-linux-amd64.deb`

macOS signs and notarizes the `.app` and `.dmg`.

The CLI archives (`morph_<version>_darwin_<arch>.tar.gz`) carry a signed and notarized `morph` as well. See [macOS CLI](#macos-cli).

Windows should sign the executables inside the zip:

- `MisterMorph.exe`
- `mistermorphc.exe`

The zip itself does not need an Authenticode signature. If we later ship an installer, sign the installer too.

Linux AppImage and deb signing are not part of the current release path. There is no Gatekeeper-equivalent step in the current Linux packaging flow.

## macOS

macOS distribution outside the Mac App Store needs Developer ID signing and notarization.

Gatekeeper checks the Developer ID signature and the notarization ticket when users launch the app.

### Required Apple Setup

You need an Apple Developer Program membership. A Mac is not required: the steps below work on Linux with `openssl`, and the release runner does all the macOS-only work. [Apple Signing Setup on Linux](apple_signing_linux.md) walks through every step, including what can go wrong on the first release. Only the team's Account Holder can create a Developer ID certificate. An Admin can create the API key.

#### 1. Developer ID Application certificate

1. Create a private key and a certificate signing request:

   ```bash
   mkdir -p ~/apple-signing && cd ~/apple-signing && umask 077
   openssl req -new -newkey rsa:2048 -nodes \
     -keyout developer_id.key -out developer_id.csr \
     -subj "/emailAddress=you@example.com/CN=Example Inc/C=US"
   ```

   `developer_id.key` is the private key. Anyone who has it can sign software as your team.

2. Sign in to `https://developer.apple.com/account`, open Certificates, IDs & Profiles → Certificates, and click `+`.
3. Choose **Developer ID Application** (not "Developer ID Installer", and not "Apple Distribution"). Select the G2 Sub-CA profile type, upload `developer_id.csr`, and download the certificate as `developer_id.cer`.
4. Build the `.p12` from the certificate, the private key and Apple's Developer ID intermediate certificate:

   ```bash
   curl -fsSLO https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
   openssl x509 -inform DER -in developer_id.cer -out developer_id.pem
   openssl x509 -inform DER -in DeveloperIDG2CA.cer -out DeveloperIDG2CA.pem
   openssl pkcs12 -export \
     -inkey developer_id.key -in developer_id.pem -certfile DeveloperIDG2CA.pem \
     -name "Developer ID Application" \
     -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
     -out DeveloperID.p12
   ```

   `openssl` asks for the export password; that is `APPLE_CERTIFICATE_PASSWORD`. Keep the `-keypbe`, `-certpbe` and `-macalg` options: the macOS `security import` command on the runner cannot read the default OpenSSL 3 encryption.

5. Print the identity string:

   ```bash
   openssl x509 -in developer_id.pem -noout -subject -nameopt multiline,-esc_msb,utf8 | grep commonName
   ```

   The common name, for example `Developer ID Application: Example Inc (TEAMID1234)`, is `APPLE_CODESIGN_IDENTITY`.

On a Mac you can do steps 1–4 with Keychain Access instead: Certificate Assistant → Request a Certificate From a Certificate Authority → Saved to disk, upload that request, install the downloaded `.cer`, and export it from My Certificates as a `.p12`. `security find-identity -v -p codesigning` prints the identity string.

A team can hold only a few Developer ID Application certificates at a time. Once the secrets are set, keep `developer_id.key` and `DeveloperID.p12` in the team's password manager and delete the copies on your disk.

#### 2. App Store Connect API key

1. Sign in to `https://appstoreconnect.apple.com` and open Users and Access → Integrations → App Store Connect API → Team Keys. The first time, the Account Holder has to request API access.
2. Click `+` (Generate API Key). Name it, for example `mistermorph-notarize`, and give it the **Developer** role.
3. Download the key, `AuthKey_<KEY ID>.p8`. Apple offers the download only once.
4. Copy the **Key ID** from the key's row and the **Issuer ID** shown above the table.
5. On a Mac you can check the key with `xcrun notarytool history --key AuthKey_ABCD123456.p8 --key-id ABCD123456 --issuer <issuer id>`. Without a Mac, the first tagged release checks it; an authentication error from `notarytool` means the key, ID or issuer is wrong.

The API key is tied to the team, not to one person's Apple ID, so it keeps working when people leave or change their passwords. Keep the `.p8` in the team's password manager.

### GitHub Secrets

The release workflow expects these secrets for the macOS DMG job and the CLI job:

- `APPLE_CERTIFICATE_BASE64`: base64-encoded `.p12` containing the Developer ID Application certificate and private key
- `APPLE_CERTIFICATE_PASSWORD`: password for the `.p12`
- `APPLE_CODESIGN_IDENTITY`: full identity, for example `Developer ID Application: Example Inc (TEAMID1234)`
- `APPLE_API_KEY_BASE64`: base64-encoded App Store Connect API key (`AuthKey_<key id>.p8`) used by `notarytool`
- `APPLE_API_KEY_ID`: the API key's ID
- `APPLE_API_ISSUER_ID`: the issuer ID shown on the App Store Connect API keys page

Set them with the GitHub CLI from the repository checkout (repeat in `mistermorph-pro`, which uses the same workflow):

```bash
base64 -w0 DeveloperID.p12 | gh secret set APPLE_CERTIFICATE_BASE64
gh secret set APPLE_CERTIFICATE_PASSWORD
gh secret set APPLE_CODESIGN_IDENTITY --body "Developer ID Application: Example Inc (TEAMID1234)"
base64 -w0 AuthKey_ABCD123456.p8 | gh secret set APPLE_API_KEY_BASE64
gh secret set APPLE_API_KEY_ID --body ABCD123456
gh secret set APPLE_API_ISSUER_ID --body <issuer id>
```

`gh secret set` without `--body` prompts for the value, which keeps the password out of shell history. On macOS, use `base64 -i <file>` instead of `base64 -w0 <file>`.

### Replacing the Certificate or Key

Update the secrets, then push a tag and check that both the CLI and the DMG release jobs pass.

- Old API key: revoke it in App Store Connect once a release has passed.
- Old Developer ID certificate: let it expire. Do not revoke it unless its private key leaked. Revoking a Developer ID certificate can stop Gatekeeper from opening software already signed with it, which includes past releases on users' machines.
- Old Apple ID app-specific password: revoke it at `https://account.apple.com` → Sign-In and Security → App-Specific Passwords. The workflow no longer uses it.

Do not commit certificates, passwords, private keys, keychain files, or local export paths.

### CI Flow

The tag release workflow does this on the macOS runner:

1. Builds the desktop binary.
2. Builds the bundled backend binary.
3. Runs `scripts/macos-signing-setup.sh`, which checks that all macOS signing secrets exist, imports the `.p12` into a temporary keychain, checks that `APPLE_CODESIGN_IDENTITY` is in it, and writes the API key to a temporary file.
4. Signs the bundled backend with `codesign --options runtime --timestamp`.
5. Signs the desktop app binary with `codesign --options runtime --timestamp`.
6. Signs the `.app` bundle.
7. Verifies the `.app` signature.
8. Creates the DMG.
9. Signs the DMG.
10. Submits the DMG to Apple with `scripts/macos-notarize.sh` (`xcrun notarytool submit --wait` with the API key), and prints the notarization log if Apple rejects it.
11. Staples the notarization ticket to the DMG and the `.app`.
12. Uploads the release assets.

The packaging script is:

```bash
desktop/wails/packaging/package-darwin.sh
```

If `CODESIGN_IDENTITY` is not set, the script uses ad hoc signing for local test distribution. Ad hoc builds are not release builds and may require testers to manually bypass Gatekeeper.

### Verification

Useful checks on macOS:

```bash
codesign --verify --deep --strict --verbose=2 MrMorph.app
spctl --assess --type execute --verbose MrMorph.app
xcrun stapler validate MrMorph.app
xcrun stapler validate MrMorph-darwin-arm64.dmg
```

### macOS CLI

GoReleaser builds the CLI archives on a macOS runner. After each darwin binary is built, the post-build hook `scripts/macos-sign-cli.sh`:

1. Signs `morph` with `codesign --options runtime --timestamp`.
2. Zips it and submits it with `scripts/macos-notarize.sh`.

The archives and `checksums.txt` are made after the hook, so they contain the signed binary. A bare binary cannot hold a stapled ticket; Gatekeeper fetches the notarization online the first time the binary runs. Tag releases set `REQUIRE_MACOS_SIGNING=true`, so a release without a signing identity fails. Snapshot builds leave the binaries with the Go linker's ad hoc signature.

The tests run in a separate Linux job before GoReleaser.

Check a downloaded CLI with:

```bash
codesign --verify --strict --verbose=2 morph
spctl --assess --type install --verbose morph
```

### Troubleshooting

Use `notarytool log` when notarization fails. Most failures are caused by a missing hardened runtime signature, an unsigned nested executable, a wrong Developer ID certificate type, or a broken timestamp.

## Windows

Windows does not have Gatekeeper. The relevant systems are Microsoft Defender SmartScreen and Smart App Control.

Unsigned downloads are treated as higher risk. Signed downloads show a verified publisher, and signed binaries are less likely to be blocked by strict policy. A new signed file can still show a SmartScreen warning until that file hash gains reputation.

### What Must Be Signed

Sign every shipped Windows executable before packaging:

- `dist/MisterMorph.exe`
- `dist/mistermorphc.exe`

If we later produce an MSI, MSIX, or NSIS installer, sign the installer after it is built. Keep the inner executables signed as well.

Always timestamp signatures. Timestamping keeps an already-signed release valid after the signing certificate expires.

### Current PFX Path

The release workflow contains a PFX-based `signtool` step for Windows.

It expects:

- `WINDOWS_CERTIFICATE_BASE64`: base64-encoded `.pfx` or `.p12` code signing certificate with private key
- `WINDOWS_CERTIFICATE_PASSWORD`: password for the certificate file

That path is acceptable if we already have a traditional code signing certificate. It is less convenient for CI because the private key is exported into GitHub Actions secrets.

### Recommended Trusted Signing Path

For new setup, prefer Microsoft Trusted Signing, also called Azure Artifact Signing in current Microsoft docs.

The account owner must prepare these Azure resources:

- Microsoft Entra tenant
- Trusted Signing account
- identity validation
- Public Trust certificate profile
- GitHub Actions identity with the certificate profile signer role

Use OpenID Connect for GitHub Actions when possible. Client-secret auth also works, but it adds another long-lived secret.

Recommended GitHub variables or secrets:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET` only if not using OIDC
- `AZURE_TRUSTED_SIGNING_ENDPOINT`, for example `https://eus.codesigning.azure.net/`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`

The CI step should run on a Windows runner after both Windows executables are built and before the zip is created. It should sign both `.exe` files with:

- file digest: `SHA256`
- timestamp URL: `http://timestamp.acs.microsoft.com`
- timestamp digest: `SHA256`

The GitHub Actions job also needs:

```yaml
permissions:
  contents: write
  id-token: write
```

`id-token: write` is only required for OIDC. It is not needed for the existing PFX flow.

### Verification

Useful checks on Windows:

```powershell
Get-AuthenticodeSignature .\dist\MisterMorph.exe
Get-AuthenticodeSignature .\dist\mistermorphc.exe
signtool verify /pa /v .\dist\MisterMorph.exe
signtool verify /pa /v .\dist\mistermorphc.exe
```

Expected result:

- status is valid
- signer is the expected publisher
- timestamp exists

SmartScreen reputation is separate from signature validity. A valid signature can still show an early-download reputation prompt for new releases.

## Operator Checklist

Before enabling release signing:

- macOS Developer ID certificate exists and can be exported with the private key (see [Required Apple Setup](#required-apple-setup)).
- The App Store Connect API key is stored in GitHub Secrets.
- Windows signing path is chosen: PFX or Trusted Signing.
- Windows executables are signed before the zip is created.
- No signing key material is committed to the repository.
- A tagged release has been tested on a clean machine for each signed OS.

## References

- Apple Developer: Developer ID certificates
  `https://developer.apple.com/help/account/create-certificates/create-developer-id-certificates/`
- Apple Developer: Notarizing macOS software before distribution
  `https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution`
- Microsoft Learn: SmartScreen reputation for Windows app developers
  `https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation`
- Microsoft Learn: Artifact Signing quickstart
  `https://learn.microsoft.com/azure/trusted-signing/quickstart`
- Microsoft Learn: Set up signing integrations to use Artifact Signing
  `https://learn.microsoft.com/azure/trusted-signing/how-to-signing-integrations`
- Azure Trusted Signing GitHub Action
  `https://github.com/Azure/trusted-signing-action`
