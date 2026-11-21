// The phone app's console server: where `morph console serve` runs. The phone app has no server of
// its own (lib/mobileHost.ts), so the login page opens this dialog to enter or change the address.
// Saving checks that a console answers there first.
//
// The address is typed, or read from a QR code: "Scan QR code" shows the camera in the field's
// place (QrScanner.tsx) and puts what a code holds into the field, when it is a server address by
// the typed address's rules. That is all a scan does: the address is a draft like a typed one, and
// only Save checks, saves and goes on. A code that holds no address, a refused or missing camera
// and a device without a scanner say so and leave the field as it was, to type in or scan again.
import { effect, signal, Text, untracked, View } from "nsh";
import { Button, Modal, TextField } from "../../components/ui";
import { authState, configureApiBase, translate as t } from "../../lib/core/context.js";
import { parseServer } from "../../lib/mobileHost";
import { serverAddress, setServer } from "../../lib/platform";
import { type ScanEvent, type ScanFailure, scannedServer } from "../../lib/qrScan";
import { QrScanner } from "./QrScanner";

/** How long a server may take to answer the check. */
const CHECK_TIMEOUT_MS = 8000;

async function checkServer(address: string): Promise<string> {
  const server = parseServer(address);
  if (!server) return t("login_server_invalid");
  const base = server.basePath === "/" ? "" : server.basePath;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${server.origin}${base}/api/auth/config`, { signal: controller.signal });
    if (!response.ok) return t("login_server_unreachable", { address: server.address, error: `HTTP ${response.status}` });
    return "";
  } catch (error) {
    const reason = controller.signal.aborted ? "timeout" : (error as Error)?.message || String(error);
    return t("login_server_unreachable", { address: server.address, error: reason });
  } finally {
    clearTimeout(timer);
  }
}

/** What a scan that gave no code says. */
const SCAN_FAILURES: Record<ScanFailure, string> = {
  unsupported: "login_scan_unsupported",
  denied: "login_scan_denied",
  no_camera: "login_scan_no_camera",
  busy: "login_scan_busy",
  interrupted: "login_scan_interrupted",
  failed: "login_scan_failed",
};

/** The camera's box: tall enough to aim with, short enough for a small phone's sheet. */
const CAMERA_HEIGHT = 240;

export function ServerDialog(props: { open: boolean; onClose: () => void; onSaved: (address: string) => void }) {
  const address = signal(serverAddress());
  const err = signal("");
  const busy = signal(false);
  // A scan runs: the camera is in the field's place.
  const scanning = signal(false);
  const cameraReady = signal(false);
  // What the last scan came to, under the field until the address is edited or another scan starts.
  const scanNote = signal<{ text: string; failed: boolean } | null>(null);

  // Each opening starts from the saved address; closing ends a scan (and with it the camera).
  effect(() => {
    const open = props.open;
    untracked(() => {
      scanning.set(false);
      cameraReady.set(false);
      if (!open) return;
      address.set(serverAddress());
      err.set("");
      busy.set(false);
      scanNote.set(null);
    });
  });

  function startScan() {
    if (busy() || scanning()) return;
    scanNote.set(null);
    cameraReady.set(false);
    scanning.set(true);
  }

  function stopScan() {
    scanning.set(false);
    cameraReady.set(false);
  }

  // What the scanner says (lib/qrScan.ts): nothing more comes after a code or a failure.
  function onScan(event: ScanEvent) {
    if (!scanning()) return;
    if (event.type === "ready") {
      cameraReady.set(true);
      return;
    }
    stopScan();
    if (event.type === "error") {
      scanNote.set({ text: t(SCAN_FAILURES[event.code] || SCAN_FAILURES.failed), failed: true });
      return;
    }
    const scanned = scannedServer(event.text);
    if (!scanned) {
      // Not an address: the field keeps what it had.
      scanNote.set({ text: t("login_scan_invalid"), failed: true });
      return;
    }
    // A draft, as if typed: Save is the user's to press.
    address.set(scanned);
    err.set("");
    scanNote.set({ text: t("login_scan_filled"), failed: false });
  }

  async function save() {
    if (busy() || scanning()) return;
    const parsed = parseServer(address());
    if (!parsed) {
      err.set(t("login_server_invalid"));
      return;
    }
    busy.set(true);
    err.set("");
    const problem = await checkServer(parsed.address);
    busy.set(false);
    if (problem) {
      err.set(problem);
      return;
    }
    const before = serverAddress();
    const saved = setServer(parsed.address);
    if (!saved) {
      err.set(t("login_server_invalid"));
      return;
    }
    if (saved !== before) {
      // Another server: the old one's session means nothing there.
      authState.clear();
      configureApiBase();
    }
    props.onSaved(saved);
  }

  return (
    <Modal
      open={props.open}
      onClose={() => (busy() ? undefined : props.onClose())}
      title={t("login_server_title")}
      description={t("login_server_description")}
      size="sm"
      // A short body: no scroll view, which would scroll the field under its label as the
      // keyboard opens.
      scroll={false}
      closeLabel={t("action_close")}
      testID="login-server-dialog"
      footer={
        <If
          when={scanning()}
          else={
            <>
              <Button variant="outlined" label={t("action_cancel")} disabled={busy()} onPress={props.onClose} />
              <Button
                variant="primary"
                label={t("action_save")}
                loading={busy()}
                disabled={busy() || address().trim() === ""}
                testID="login-server-save"
                onPress={() => void save()}
              />
            </>
          }
        >
          <Button variant="outlined" label={t("login_scan_stop")} testID="login-server-scan-stop" onPress={stopScan} />
        </If>
      }
    >
      <If
        when={scanning()}
        else={
          <View class="gap-3">
            <TextField
              label={t("login_server_address")}
              value={address()}
              onChange={(value) => {
                address.set(value);
                err.set("");
                scanNote.set(null);
              }}
              onSubmit={() => void save()}
              placeholder={t("login_server_placeholder")}
              hint={t("login_server_hint")}
              keyboardType="url"
              mono
              // After a scan the note under the field is what to read: the keyboard stays down.
              autoFocus={!scanNote()}
              clearable
              disabled={busy()}
              error={err()}
              testID="login-server-input"
            />
            {/* What a scan came to is read out as it appears. */}
            <View class="gap-2" android={{ accessibilityLiveRegion: "polite" }}>
              <Button
                variant="outlined"
                block
                label={t("login_scan_button")}
                disabled={busy()}
                testID="login-server-scan"
                onPress={startScan}
              />
              <If
                when={scanNote()}
                else={
                  <Text class="text-xs leading-[17.4px] text-muted-foreground" testID="login-server-scan-help">
                    {t("login_scan_help")}
                  </Text>
                }
              >
                <Text
                  role={scanNote()?.failed ? "alert" : undefined}
                  class={`text-xs leading-[17.4px] ${scanNote()?.failed ? "text-danger" : "text-foreground"}`}
                  testID={scanNote()?.failed ? "login-server-scan-error" : "login-server-scan-filled"}
                >
                  {scanNote()?.text}
                </Text>
              </If>
            </View>
          </View>
        }
      >
        <View class="gap-3" android={{ accessibilityLiveRegion: "polite" }} testID="login-server-scanner">
          <View class="overflow-hidden rounded-(--radius) border border-line-soft bg-[#111318]" style={{ height: CAMERA_HEIGHT }}>
            <QrScanner onEvent={onScan} accessibilityLabel={t("login_scan_camera")} class="flex-1" testID="login-server-camera" />
          </View>
          <Text class="text-xs leading-[17.4px] text-muted-foreground" testID="login-server-scan-status">
            {t(cameraReady() ? "login_scan_aim" : "login_scan_starting")}
          </Text>
        </View>
      </If>
    </Modal>
  );
}
