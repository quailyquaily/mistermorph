// The QR scanner's camera view (the server dialog's, ServerDialog.tsx): a web view showing the
// scanner's page (lib/qrScannerPage.js), since the camera and the QR decoder are the system
// browser's, not nsh's. It exists only while a scan runs: mounting it is what asks for the camera
// (the web view's page does, and nsh.json's `webview.media` lets it), and whatever ends it (a
// code, a failure, Cancel, the dialog closing, the login page going away, the app leaving the
// screen) tells the page to release the camera before the web view goes with it.
import type { WebViewRef } from "nsh";
import { cleanup, effect, lifecycle, untracked, WebView } from "nsh";
import { openScan, type ScanEvent } from "../../lib/qrScan";
import { scannerPage } from "../../lib/qrScannerPage.js";

// The page's address: https, so the web view lets it ask for the camera (a secure context). The
// page is the text above, never loaded from there: `.invalid` names no host.
const SCANNER_BASE = "https://qr-scanner.invalid/";

export function QrScanner(props: { onEvent: (event: ScanEvent) => void; accessibilityLabel?: string; class?: string; testID?: string }) {
  const scan = openScan((event) => props.onEvent(event));
  cleanup(() => scan.close());
  // Away from the screen the camera is not kept. A permission question only covers the app
  // ("inactive"), so it does not end the scan it belongs to.
  effect(() => {
    if (lifecycle() === "background") untracked(() => scan.fail("interrupted"));
  });
  return (
    <WebView
      ref={(node: WebViewRef) => scan.attach((message) => node.postMessage(message))}
      html={scannerPage()}
      baseUrl={SCANNER_BASE}
      scrollable={false}
      incognito
      onMessage={(event) => scan.receive(event.data)}
      onError={(event) => {
        console.warn("QR scan: the scanner's page did not load:", event.code || "", event.message);
        scan.fail(event.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" ? "unsupported" : "failed");
      }}
      accessibilityLabel={props.accessibilityLabel}
      class={props.class}
      testID={props.testID}
    />
  );
}
