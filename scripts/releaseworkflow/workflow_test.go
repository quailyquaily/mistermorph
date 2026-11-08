package releaseworkflow

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWindowsSigningWorkflowContract(t *testing.T) {
	workflow := readRepoFile(t, ".github", "workflows", "windows-signing.yml")

	required := []string{
		"workflow_dispatch:",
		"tag:",
		"ref: ${{ inputs.tag }}",
		"RELEASE_TAG: ${{ inputs.tag }}",
		"runs-on: windows-2022",
		"actions/checkout@v5",
		"actions/setup-go@v6",
		"pnpm/action-setup@v6",
		"actions/setup-node@v5",
		"secrets.ES_USERNAME",
		"secrets.ES_PASSWORD",
		"secrets.ES_CREDENTIAL_ID",
		"secrets.ES_TOTP_SECRET",
		"actions/setup-java@v5",
		"CodeSignTool/releases/download/v1.3.2/CodeSignTool-v1.3.2.zip",
		"f14b1e1ef14bfa1fd00279c363aab0debbf5dcfba0e4bcdce5d22bb771de0e3a",
		"[System.Diagnostics.ProcessStartInfo]::new()",
		"$processInfo.ArgumentList.Add($argument)",
		"$processInfo.RedirectStandardOutput = $true",
		`"scan_code"`,
		"code object is not a malware. You can proceed signing this code object",
		`"batch_sign"`,
		"Batch sign command executed successfully.",
		"MrMorph.exe",
		"morph.exe",
		"morph-amd64.exe",
		"morph-arm64.exe",
		"signtool verify /pa /all /v /tw",
		"Publish update manifest and release index to R2",
		"./scripts/release-publish-metadata.sh",
		"gh release upload",
	}
	for _, token := range required {
		if !strings.Contains(workflow, token) {
			t.Errorf("windows signing workflow missing %q", token)
		}
	}

	assertOrdered(t, workflow,
		"Download CodeSignTool",
		"$processInfo.ArgumentList.Add($argument)",
		"foreach ($file in $unsignedFiles)",
		`"scan_code"`,
		`"batch_sign"`,
		`$signedFiles = @(Get-ChildItem $signedDir -File -Filter "*.exe")`,
		"signtool verify /pa /all /v /tw",
		"Package Windows release assets",
		"Upload Windows release files to R2",
		"Publish update manifest and release index to R2",
	)

	for _, token := range []string{
		"workflow_call:",
		"\n  push:",
		"SSLcom/esigner-codesign@",
		"CodeSignTool.bat",
		"ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION",
	} {
		if strings.Contains(workflow, token) {
			t.Errorf("manual Windows workflow must not contain %q", token)
		}
	}
}

func TestReleaseExecutableNames(t *testing.T) {
	checks := []struct {
		file     []string
		required []string
	}{
		{[]string{".goreleaser.yaml"}, []string{"binary: morph"}},
		{[]string{"scripts", "install-release.sh"}, []string{`BIN_NAME="morph"`, `BIN_NAME="morph.exe"`}},
		{[]string{"scripts", "build-backend.sh"}, []string{"./bin/morph", "./bin/morph.exe"}},
		{[]string{"scripts", "build-desktop.sh"}, []string{"./bin/MrMorph", "./bin/MrMorph.exe", "./bin/morph", "./bin/morph.exe"}},
		{[]string{"scripts", "mistermorph-wrapper.sh"}, []string{`MORPH_CLI_PATH="${MORPH_CLI_PATH:-morph}"`}},
		{[]string{"desktop", "nsh", "packaging", "package-darwin.sh"}, []string{`APP_EXECUTABLE_NAME="${APP_EXECUTABLE_NAME:-MrMorph}"`, `BUNDLED_BACKEND_NAME="${BUNDLED_BACKEND_NAME:-morph}"`}},
		{[]string{"desktop", "nsh", "packaging", "package-linux-appimage.sh"}, []string{`APP_BINARY_NAME="${APP_BINARY_NAME:-MrMorph}"`, `BUNDLED_BACKEND_NAME="${BUNDLED_BACKEND_NAME:-morph}"`}},
		{[]string{"desktop", "nsh", "packaging", "package-linux-deb.sh"}, []string{`APP_BINARY_NAME="${APP_BINARY_NAME:-MrMorph}"`, `BUNDLED_BACKEND_NAME="${BUNDLED_BACKEND_NAME:-morph}"`}},
	}
	for _, check := range checks {
		content := readRepoFile(t, check.file...)
		for _, token := range check.required {
			if !strings.Contains(content, token) {
				t.Errorf("%s missing executable name %q", filepath.Join(check.file...), token)
			}
		}
	}

	workflowChecks := []struct {
		file     []string
		required []string
	}{
		{[]string{".github", "workflows", "release.yml"}, []string{"raw_desktop_binary: dist/MrMorph", "bundled_backend_binary: dist/morph", `BUNDLED_BACKEND_NAME="morph"`}},
		{[]string{".github", "workflows", "build_app.yaml"}, []string{`--desktop-output "./dist/MrMorph${exe}"`, `--backend-output "./dist/morph${exe}"`}},
	}
	for _, check := range workflowChecks {
		content := readRepoFile(t, check.file...)
		for _, token := range check.required {
			if !strings.Contains(content, token) {
				t.Errorf("%s missing executable name %q", filepath.Join(check.file...), token)
			}
		}
	}
}

func TestReleaseArtifactNames(t *testing.T) {
	checks := []struct {
		file     []string
		required []string
	}{
		{[]string{".goreleaser.yaml"}, []string{`name_template: "morph_{{ .Version }}_{{ .Os }}_{{ .Arch }}"`}},
		{[]string{"scripts", "install-release.sh"}, []string{`ASSET_NAME="morph_${ASSET_VERSION}_${OS}_${ARCH}.${ARCHIVE_EXT}"`}},
		{[]string{"desktop", "nsh", "packaging", "package-darwin.sh"}, []string{`MrMorph-darwin-${ARCH}.dmg`, `MrMorph-darwin-${ARCH}.tar.gz`}},
		{[]string{"desktop", "nsh", "packaging", "package-linux-appimage.sh"}, []string{`MrMorph-linux-${ARCH}.AppImage`, `MrMorph-linux-${ARCH}.tar.gz`}},
		{[]string{"desktop", "nsh", "packaging", "package-linux-deb.sh"}, []string{`MrMorph-linux-${ARCH}.deb`}},
		{[]string{".github", "workflows", "release.yml"}, []string{"MrMorph-linux-amd64.AppImage", "MrMorph-linux-amd64.deb", "MrMorph-darwin-arm64.dmg"}},
		{[]string{".github", "workflows", "windows-signing.yml"}, []string{"MrMorph-windows-amd64.zip", `morph_${version}_windows_amd64.zip`, `morph_${version}_windows_arm64.zip`}},
	}
	for _, check := range checks {
		content := readRepoFile(t, check.file...)
		for _, token := range check.required {
			if !strings.Contains(content, token) {
				t.Errorf("%s missing release artifact name %q", filepath.Join(check.file...), token)
			}
		}
	}
}

func TestReleaseWorkflowsPublishToChannel(t *testing.T) {
	for _, name := range []string{"release.yml", "windows-signing.yml"} {
		workflow := readRepoFile(t, ".github", "workflows", name)
		for _, token := range []string{
			"RELEASE_CHANNEL: ",
			"GITHUB_RELEASES_TO_KEEP: ",
			"${RELEASE_CHANNEL}/releases/",
			"./scripts/release-publish-metadata.sh",
		} {
			if !strings.Contains(workflow, token) {
				t.Errorf("%s missing %q", name, token)
			}
		}
		// Every channel writes under its own prefix; nothing may write the
		// shared, unprefixed paths used before channels existed.
		for _, token := range []string{"/latest/update.json", "R2_PREFIX: releases/"} {
			if strings.Contains(workflow, token) {
				t.Errorf("%s writes an unprefixed path %q", name, token)
			}
		}
	}

	release := readRepoFile(t, ".github", "workflows", "release.yml")
	assertOrdered(t, release,
		"Publish update manifest and release index to R2",
		"./scripts/release-prune-github.sh",
	)
}

func TestAutomaticReleaseExcludesUnsignedWindowsArtifacts(t *testing.T) {
	releaseWorkflow := readRepoFile(t, ".github", "workflows", "release.yml")
	goReleaserConfig := readRepoFile(t, ".goreleaser.yaml")

	for _, token := range []string{
		"WINDOWS_CERTIFICATE_BASE64",
		"WINDOWS_CERTIFICATE_PASSWORD",
		"label: windows-amd64",
		"windows-signing:",
		"uses: ./.github/workflows/windows-signing.yml",
	} {
		if strings.Contains(releaseWorkflow, token) {
			t.Errorf("release workflow still contains obsolete Windows path %q", token)
		}
	}

	if strings.Contains(goReleaserConfig, "- windows") {
		t.Fatal("GoReleaser must not publish unsigned Windows archives")
	}
}

func TestDesktopPackagesRegisterMisterMorphApplicationID(t *testing.T) {
	for _, file := range [][]string{
		{"desktop", "nsh", "packaging", "package-darwin.sh"},
		{"desktop", "nsh", "packaging", "package-linux-appimage.sh"},
		{"desktop", "nsh", "packaging", "package-linux-deb.sh"},
	} {
		content := readRepoFile(t, file...)
		if !strings.Contains(content, "com.mistermorph") {
			t.Errorf("%s does not register com.mistermorph", filepath.Join(file...))
		}
	}

	for _, file := range [][]string{
		{"desktop", "nsh", "packaging", "package-linux-appimage.sh"},
		{"desktop", "nsh", "packaging", "package-linux-deb.sh"},
	} {
		content := readRepoFile(t, file...)
		if !strings.Contains(content, "APPLICATION_ID") || !strings.Contains(content, "Icon=${APPLICATION_ID}") {
			t.Errorf("%s does not associate the application ID with its icon", filepath.Join(file...))
		}
		if !strings.Contains(content, `DESKTOP_FILE_ID="${DESKTOP_FILE_ID:-com.mistermorph}"`) ||
			!strings.Contains(content, "${DESKTOP_FILE_ID}.desktop") {
			t.Errorf("%s does not name its desktop file after the window's app id", filepath.Join(file...))
		}
	}
}

func TestDarwinPackageBuildsStyledDMG(t *testing.T) {
	script := readRepoFile(t, "desktop", "nsh", "packaging", "package-darwin.sh")

	for _, token := range []string{
		"DMG_BACKGROUND_SOURCE",
		"DMG_STAGING_DIR",
		"DMG_DEVICE",
		".background",
		`ln -s "/Applications"`,
		"osascript",
		"if exists disk volumeName then",
		"-format UDRW",
		"hdiutil attach",
		"hdiutil detach",
		"hdiutil convert",
	} {
		if !strings.Contains(script, token) {
			t.Errorf("macOS package script missing %q", token)
		}
	}
	if strings.Contains(script, `-mountpoint "${DMG_MOUNT_DIR}"`) {
		t.Fatal("macOS package script must let Disk Arbitration mount the DMG where Finder can see it")
	}

	assertOrdered(t, script,
		"\t-format UDRW",
		"\nhdiutil attach",
		"\nosascript -",
		"\tif hdiutil detach",
		"\nhdiutil convert",
		`echo "signing DMG`,
	)

	background := readRepoFile(t, "desktop", "nsh", "packaging", "dmg-background.svg")
	if !strings.Contains(background, `viewBox="0 0 760 480"`) {
		t.Fatal("DMG background must match the Finder window content size")
	}
	if len(readRepoFile(t, "desktop", "nsh", "packaging", "dmg-background.png")) == 0 {
		t.Fatal("DMG background PNG is empty")
	}
}

func assertOrdered(t *testing.T, text string, tokens ...string) {
	t.Helper()
	previous := -1
	for _, token := range tokens {
		index := strings.Index(text, token)
		if index < 0 {
			t.Fatalf("missing ordered token %q", token)
		}
		if index <= previous {
			t.Fatalf("token %q appears out of order", token)
		}
		previous = index
	}
}

func readRepoFile(t *testing.T, parts ...string) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test file path")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	path := filepath.Join(append([]string{repoRoot}, parts...)...)
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", filepath.Join(parts...), err)
	}
	return string(content)
}

func TestDesktopReleasesBuildTheNshShell(t *testing.T) {
	setup := readRepoFile(t, ".github", "actions", "setup-desktop-build", "action.yml")
	for _, token := range []string{
		"default: v0.4.0",
		"releases/download/${NSH_VERSION}/install.sh",
		"releases/download/$env:NSH_VERSION/install.ps1",
		"workspaces: desktop/nsh -> target",
	} {
		if !strings.Contains(setup, token) {
			t.Errorf("desktop build setup missing %q", token)
		}
	}
	cargo := readRepoFile(t, "desktop", "nsh", "Cargo.toml")
	if !strings.Contains(cargo, `nsh-engine = { version = "=0.4.0"`) {
		t.Error("desktop/nsh pins another nsh version than the CI setup installs")
	}

	for _, workflow := range []string{"release.yml", "windows-signing.yml", "build_app.yaml"} {
		content := readRepoFile(t, ".github", "workflows", workflow)
		if !strings.Contains(content, "uses: ./.github/actions/setup-desktop-build") {
			t.Errorf("%s does not set up the desktop build", workflow)
		}
		if strings.Contains(strings.ToLower(content), "wails") {
			t.Errorf("%s still builds the Wails app", workflow)
		}
	}
	release := readRepoFile(t, ".github", "workflows", "release.yml")
	windows := readRepoFile(t, ".github", "workflows", "windows-signing.yml")
	for name, content := range map[string]string{"release.yml": release, "windows-signing.yml": windows} {
		if !strings.Contains(content, "./desktop/nsh/build.sh") {
			t.Errorf("%s does not build the shell with desktop/nsh/build.sh", name)
		}
		if !strings.Contains(content, `-tags "noembedconsole ${GO_BUILD_TAGS}"`) {
			t.Errorf("%s bundles a backend with an embedded console the shell does not use", name)
		}
	}
}

func TestAndroidAppIsReleasedWithTheReleaseKeystore(t *testing.T) {
	release := readRepoFile(t, ".github", "workflows", "release.yml")
	for _, token := range []string{
		"android-app:",
		"web/console-nsh/scripts/build-android.sh",
		"secrets.ANDROID_KEYSTORE_BASE64",
		`--keystore "${keystore}" --key-alias "${ANDROID_KEY_ALIAS}"`,
		"MrMorph-android.apk",
		"needs: [desktop-apps, android-app]",
	} {
		if !strings.Contains(release, token) {
			t.Errorf("release workflow missing %q", token)
		}
	}
	buildApp := readRepoFile(t, ".github", "workflows", "build_app.yaml")
	if !strings.Contains(buildApp, "web/console-nsh/scripts/build-android.sh --out dist/MrMorph-android.apk") {
		t.Error("build_app.yaml does not build the Android app")
	}
	script := readRepoFile(t, "web", "console-nsh", "scripts", "build-android.sh")
	if !strings.Contains(script, `android:usesCleartextTraffic="true"`) {
		t.Error("the Android build no longer lets the app reach http:// console servers")
	}
}
