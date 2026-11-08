// The phone app's console server: where `morph console serve` runs. The phone app has no server of
// its own (lib/mobileHost.ts), so the login page opens this dialog to enter or change the address.
// Saving checks that a console answers there first.
import { effect, signal, untracked, View } from "nsh";
import { Button, Modal, TextField } from "../../components/ui";
import { authState, configureApiBase, translate as t } from "../../lib/core/context.js";
import { parseServer } from "../../lib/mobileHost";
import { serverAddress, setServer } from "../../lib/platform";

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

export function ServerDialog(props: { open: boolean; onClose: () => void; onSaved: (address: string) => void }) {
  const address = signal(serverAddress());
  const err = signal("");
  const busy = signal(false);

  // Each opening starts from the saved address.
  effect(() => {
    if (props.open) {
      untracked(() => {
        address.set(serverAddress());
        err.set("");
        busy.set(false);
      });
    }
  });

  async function save() {
    if (busy()) return;
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
      <View class="gap-1">
        <TextField
          label={t("login_host")}
          value={address()}
          onChange={(value) => {
            address.set(value);
            err.set("");
          }}
          onSubmit={() => void save()}
          placeholder={t("login_server_placeholder")}
          keyboardType="url"
          mono
          autoFocus
          clearable
          disabled={busy()}
          error={err()}
          testID="login-server-input"
        />
      </View>
    </Modal>
  );
}
