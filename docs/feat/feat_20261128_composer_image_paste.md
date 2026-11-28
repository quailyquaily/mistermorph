---
date: 2026-11-28
title: Pasting images into the chat composer (Web, desktop, Android, iOS)
status: implemented (no real browser menu, desktop OS, device, deployment or provider checked)
---

# Pasting images into the chat composer

## Behaviour

A user pastes an image into the focused chat composer: a screenshot, or an image copied in a
browser, an image editor or another app. Each image becomes a pending attachment of the draft,
through the upload every picked or dropped file takes (FT110/FT195): the pill, the preview from the
device, Retry after a failed upload, Remove, and the sent message's `file_references`. A paste never
sends a message or starts a task. The paste's text, if it has any, goes into the field at the caret
as before (nsh's `pasteBehavior` "insert"), so a text-only paste is unchanged, and a mixed paste
inserts its text and attaches its images, when the platform delivers both.

The same rules hold on every platform, in `components/chat/imagePaste.ts` and the chat page's
controller (`pasteOnComposer`):

- **The bytes decide.** A pasted file's name and type are the platform's guess: nsh names an image
  of bytes it does not know `image.png` (nsh-core `PastedFile::image`), and a browser may give no
  name or a wrong type. The first and last 64 bytes are read: PNG (with its header and end chunks),
  JPEG and WebP (with a RIFF size that fits the file) are taken, named after their bytes
  (`holiday.png` holding a JPEG is attached as `holiday.jpg`, `image/jpeg`; nameless or generic
  ones as `clipboard-image-<n>.<ext>`). GIF, BMP, TIFF, HEIC, AVIF and SVG/HTML markup are refused,
  naming the formats that work and Upload Files for keeping the file as it is; an empty file,
  bytes that are no image and a truncated PNG or WebP are refused as unreadable. Nothing is
  converted in the Console. Markup is never shown or run, a clipboard URL or path is never fetched
  or opened, and a file of another known type (a PDF from a file manager) is left alone.
- **Upload budgets, before any upload.** A file of up to 128 MiB (134,217,728 bytes) is admitted,
  pasted, picked or dropped alike (`components/chat/uploads.ts`); a larger one is refused on the
  device, with no upload and no Retry. A paste attaches up to 256 MiB (268,435,456 bytes) of images
  in all, in its order: the image that would pass that is refused and named, a later one that still
  fits is taken. Sizes are those the platform delivered, after any native conversion. The agent
  checks the same budgets again (see "Upload transport").
- **Stored is not shown to the model.** The console's agent shows the model at most three images
  of a message, each at most 5 MiB (`consoleLLMMaxImages`, `consoleLLMMaxImageBytes` in
  `cmd/mistermorph/consolecmd/console_file_references.go`), and fails the whole task for a larger
  one (`internal/channelruntime/imageinput`). Those limits never refuse a paste: a 12–19 MB original
  is uploaded, and its pill says "Uploaded. Over 5 MiB (5,242,880 bytes): the model cannot be shown
  it". A draft is not sent while it holds an image (a `.png`, `.jpg`, `.jpeg` or `.webp`, the
  extensions the agent takes for images) over 5 MiB or more than three of them, from a paste, the
  picker or a drop: the page says which and how many to remove, and the text and files stay. The
  size is the device's, then the one the agent's upload answer gives (`size_bytes`). There is no
  "send as an ordinary file only" path: for a model that takes images the runtime puts every such
  image into the model's input (and fails the task over 5 MiB), so removal or a smaller copy is
  required, and nothing is compressed or converted.
- **At most two uploads at once.** A composer runs two uploads at a time; the rest wait their turn in
  the order they were added, and one removed (or of a draft gone) while it waited is not sent.
- **In order.** Pastes are checked one after another, each after the one before, and a paste's files
  keep their order: a large first image read slowly never lands after a later small one, and the
  upload of each starts as it is added, so their pills keep the order of the pastes whatever order
  the uploads end in.
- **For the draft it was made in.** The draft is named as the paste comes (endpoint, topic, the
  number of drafts sent, the page open). A paste whose draft is no longer on screen when its check
  ends (another conversation or agent, a sent draft, a page left) is dropped without a word; an
  upload already under way keeps to its own draft, as uploads did.
- **Said when refused.** A paste the composer cannot take now says why, and changes nothing: while
  a message is being edited (an edit sends text only), while a message is being sent, without an
  agent to send to (or what else closes the add button). The TODO list's composer takes words only:
  a pasted image there is refused with that reason, and its text still goes in. Refusals are one
  notice for the paste, a line per reason, naming the files.
- **Retry only where it can help.** A failed upload keeps the pasted `File` (its bytes are in the
  app), so Retry sends the same bytes again after a network failure, a busy console (503) or a
  timeout. A refusal over a size has no Retry and says which limit refused it: the agent's coded 413
  (per file or per request, in MiB and bytes), an older agent's own words ("upload exceeds 64 MiB"),
  or, for an HTML or empty 413 from a proxy in front of a server, that "the server, or a proxy in
  front of it" refused it and gave no limit. An agent that refuses for another reason (an upstream
  401 or 500) leaves the pill with its message; the console's own session expiring sends the user to
  log in as every other request does.
- **The file cache can let a file go.** Uploads without a workspace land in the agent's file cache
  (512 MiB by default, oldest evicted first; only the batch being written is protected). Five large
  uploads can evict the first before the message is sent: the send is then refused
  (`file_references[i]: file does not exist`), the draft stays, and that pill says the agent no longer
  has the file, with Retry upload while its bytes are on the device (a pasted image), or to remove and
  attach it again (a picked file the host let go).

## Upload transport (FT197 defaults)

The upload budgets are built-in defaults, with no configuration key, the same in the runtime
(`internal/daemonruntime/upload_limits.go`) and the Console's proxy
(`cmd/mistermorph/consolecmd/proxy_upload.go`), for the Console's own agent and remote ones:

- 128 MiB (134,217,728 bytes) per file and 129 MiB (135,266,304 bytes) per multipart request, each
  checked on its own (several files share a request's budget; the extra MiB is room for framing and
  ordinary fields). Before FT197 the whole request was limited to 64 MiB. A refusal is `413` with
  JSON `error`, `code` (`upload_file_too_large` / `upload_request_too_large`) and `limit_bytes`; a
  declared length over the budget is refused before the body is read. The 8 MiB multipart memory
  threshold, the five-minute body read and the 64 MiB budget of files the agent sends are unchanged.
- The proxy streams `/files/upload` to the endpoint instead of buffering it whole (it used to read
  64 MiB into memory); the in-process runtime parses as it reads (parts over 8 MiB to temporary
  files, removed on every exit), a remote runtime is sent the body as it arrives. At most four
  uploads stream at once across the Console process; another gets `503`, `code: upload_busy`,
  `Retry-After: 5`.
- Forwarding an upload to a remote runtime may take five minutes (the body's read allowance, as both
  run together); every other proxied call keeps its 20 seconds. A stalled forward ends with `504` and
  cancels the remote request; a client that goes away stops the forwarding.
- A remote runtime from before FT197 still refuses above 64 MiB per request; its 413 is shown as it
  said it, and the draft stays. A reverse proxy or ingress in front of the Console or a runtime must
  allow 129 MiB bodies and five-minute requests; none was inspected or changed here.
- What the model is then sent is larger again: an image goes to the provider base64-encoded
  (4 × ceil(bytes / 3), plus JSON), so a 5 MiB image is about 7 MB in the request.

Provider limits, from the providers' documentation as read on 2026-11-28 (not exercised against the
APIs): Anthropic's Claude API takes images of up to 10 MB base64-encoded (5 MB on Amazon Bedrock),
100 or 600 images and 128 MB a request
(https://platform.claude.com/docs/en/build-with-claude/vision); OpenAI states no per-image byte limit
(a 30,000-patch limit per image), up to 1,500 images and 512 MB a request
(https://developers.openai.com/api/docs/guides/images-vision); Google's Gemini API limits a request
with inline image data to 20 MB in all (https://aistudio.google.com/docs/image-understanding). So the
console's 5 MiB per image fits Anthropic's API and OpenAI, but not Bedrock's 5 MB base64 (a 5 MiB
image is about 7 MB encoded), and three images of 5 MiB (about 21 MB encoded) exceed Gemini's 20 MB
inline request. The console does not know an agent's provider when a draft is sent, so these lower
limits are not enforced before sending; such a task fails at the provider with the provider's error.

## The platforms

What each platform hands over is read by the platform's own code when the user pastes; the Console
never reads the clipboard itself, never polls it and asks for no clipboard, storage or photo
permission.

### Web (`nsh.js`, nsh-platform-web 0.6.0)

The field's `paste` event: `clipboardData.files` are read with `arrayBuffer()` and handed to the app
with the text and HTML (`pasted`), after the browser inserted the text. No `navigator.clipboard`
read, so no permission prompt. Files of one paste keep the browser's order; the bytes of two quick
pastes may arrive in either order, which the Console's one-after-another check puts right.

### Desktop app (GPUI, the vendored nsh-platform-gpui 0.6.0)

Ctrl+V / Command+V, Shift+Insert, macOS's Edit > Paste (the same key sent to the focused field) and
the field's right-click Paste (enabled for an image-only clipboard while the field listens to
pastes) all go through `text_input.rs` `paste`, which reads GPUI's clipboard once.
`desktop/nsh/patches/nsh-paste-images.patch` types each image after the format GPUI read it as
(upstream called an SVG `image.png`) and converts BMP, TIFF and ICO to PNG within decode limits
(16384 px a side, 256 MiB): a Windows screenshot (Snipping Tool, Print Screen) is a
device-independent bitmap, which GPUI makes a BMP, and could not be pasted otherwise. What GPUI
itself does not deliver stays so:

- On macOS and Wayland GPUI reads the clipboard's text and its image only when there is no text, so
  an image copied together with text (some browsers and office apps put both) pastes as its text
  alone. X11 offers images first; Windows reads the first text, image and file list.
- GPUI reads the whole image before nsh sees it: its size cannot be bounded earlier, and a
  converted PNG can be larger than the BMP it came from (the Console checks the delivered size).

### Android app (nsh-platform-android 0.6.0, patched InputBox)

Android 12 (API 31) and newer: the field's receive-content listener takes the system menu's Paste
and Ctrl+V, and keyboards' image insertion (`image/*`, Gboard's clipboard chips and image results).
Before Android 12 only the long-press menu's Paste (and Ctrl+V) reach the app; keyboards cannot
insert images there and nothing here promises it. Each image is read from its content URI with the
temporary grant of the paste, while it lasts.

The app builds a patched copy of the runtime's `InputBox`
(`web/console-nsh/android/src/com/longbridge/nsh/InputBox.java`, swapped in by
`scripts/android-host.sh dex` as ScrollBox is, for nsh 0.6.0 only):

- An image is read only up to 128 MiB, the upload budget, and a paste's images only up to 256 MiB
  together (`PasteReads`): the size the provider declares is checked first, and a stream that runs
  past the bound stops being read. nsh read it whole into memory. The bound limits what is read, not
  what the device can spare: a large image still takes its size in memory (and once more as a JS
  `File`), and a failed allocation is told as unreadable.
- An image too large (`too_large`), a paste past its total (`batch_too_large`), or an image whose URI
  cannot be read (an expired or missing grant, a failing provider, out of memory), is told to the Console (`PasteNotices` → `morph.paste.refused` with the reason and
  a count, nothing of the image), which says so while the composer has the focus. nsh only logged
  it (with the exception's text); the log line now names the exception's class alone.
- Before Android 12, the menu's Paste of a clipboard holding an image inserts the clip's text items
  alone; TextView's own paste coerces every item to text, which on some releases is the image's
  `content://` URI.

The app's `minSdk` as nsh packages it is 26 (Android 8.0); `android-host.sh` dexes with
`--min-api 28` as before.

### iOS app (nsh-platform-ios 0.6.0, prebuilt)

From the runtime's sources (`src/input.rs`, `src/system.rs`; the packaged runtime is a prebuilt
component the build adds on macOS, not checked against them): the edit menu offers Paste for an
image-only pasteboard while the field listens to pastes (`can_paste_more`), and the field's
`paste:` reads the general pasteboard then. One item: its PNG, JPEG or GIF data as it is, otherwise
(HEIC from Photos, for one) UIKit's PNG of the image; several items: each as a PNG. A PNG made from
a camera photo can be several times the original's size: the Console checks what was delivered,
attaches it when it is within 128 MiB (with the model note when over 5 MiB) and refuses it naming
the 128 MiB limit otherwise; repasting a smaller or JPEG copy is the remedy. No conversion size was
measured here. iOS's own paste consent belongs to the system: by Apple's documentation a paste chosen from the
system's menu or keyboard shortcut needs no prompt (not checked here), and a read the system denies
gives the app no image, so no attachment and no message: the runtime tells the app nothing then. The runtime reads a pasted image whole and cannot be
patched from the app (it is prebuilt); a bounded read and a refusal the app hears would need nsh
itself (nsh-platform-ios `system.rs` `pasted`).

## Tests

Server side (Go, `go test ./...`), with streamed multipart bodies of exact byte counts (no committed
fixtures, no body held whole; `internal/daemonruntime/uploadtest`):

- `internal/daemonruntime/upload_limits_test.go`: a request of exactly 135,266,304 bytes (two files)
  stored byte for byte and one byte more refused (413, code, limit, nothing stored, no temporary file
  left); a declared oversize request refused with nothing read (and 401 first when unauthorized); a
  file of exactly 134,217,728 bytes stored and one byte more refused within the request budget, the
  small file beside it not kept; long metadata taking a request over; an interrupted transfer leaving
  nothing; valid JPEG/PNG/WebP of 12,000,000 / 19,922,944, 13,000,000 / 19,922,944 and 12,582,912 /
  19,000,000 bytes and a 68,157,440-byte (65 MiB) JPEG stored byte for byte and decoding (request
  bytes = file bytes + 168–170 bytes of framing).
- `cmd/mistermorph/consolecmd/proxy_upload_test.go`: the same 129 MiB and 128 MiB boundaries
  through the proxy and the in-process runtime together, with matching refusals; a declared oversize
  body refused unread; the body handed to the endpoint before a byte was read (no buffering); four
  uploads at once and the fifth refused with 503/Retry-After, slots given back after success,
  failure, size refusal and cancellation; a remote upload stalled past its timeout ending in 504 and
  cancelling the remote request; a cancelled client stopping the forwarding; HTML, pre-FT197 and
  lower JSON 413s of a remote forwarded as said; the stock timeouts (20 s ordinary, 5 min upload)
  and a call slower than the ordinary timeout passing as an upload; a 19 MiB remote upload throttled
  to about 31 s succeeding with the stock client; five 110 MiB uploads evicting the oldest from the
  stock 512 MiB cache, and its reference refused by index.

Console:

- `tests/chat-image-paste.test.tsx` (headless, in `scripts/test.sh`): byte checks for every format,
  markup and truncated files; naming; exactly 128 MiB per file and one byte more, exactly 256 MiB
  per paste and one byte more (size stubs), no model limit at the paste; the two-at-a-time gate; the
  wording and retryability of every upload failure; a read that fails;
  pastes in order though the first one's bytes come last; a paste for a draft no longer on screen;
  blocked before and during the check; the send's refusal. In the real console (desktop): an image
  pasted into an empty draft is uploaded with the session (`Bearer`, the local endpoint, the topic)
  and sent with the message, and previews from the device; text and images into a new
  conversation's draft (the text at the caret, a mislabelled JPEG uploaded as a JPEG, a GIF refused);
  two quick pastes whose first upload ends last keep their order; an agent's 401 and Retry with the
  same bytes, refused empty and truncated images, the draft's text kept, a removed image pasted
  again; a fourth image and a picked 5 MiB + 1 image attached, with the pill's model note, and the
  send refusing until they are removed; a picked file of 128 MiB + 1 refused without upload or Retry
  and one of exactly 128 MiB uploaded; coded, HTML and busy refusals (Retry for the busy one only);
  three pastes uploading two at a time in order; a send refused for an evicted attachment, marked,
  re-uploaded and sent; a paste
  while editing a message; the TODO list. In the Android and iOS apps: the same upload and send
  path, a BMP refused. Android's `morph.paste.refused`: said only with the composer focused, and
  only for the reasons the native part sends.
- `tests/chat-image-paste-web.test.tsx` with `tests/fixtures/composer-paste-app.tsx`: the real
  ChatComposer with the paste handling, headless and in Chrome (`nsh test --target web`, run by
  `scripts/test.sh` with the whole suite; `WEB_TESTS=0` skips it). In Chrome `app.paste` dispatches
  a real `ClipboardEvent` with a `DataTransfer` on the focused textarea, which nsh.js reads: an image
  attached named and typed after its bytes, the order of five files and refusals, text and image
  together, text alone, empty and truncated files, two pastes in order, and a valid 19 MiB PNG
  (19,922,944 bytes, written by `scripts/make-paste-fixtures.mjs`, not committed) attached whole.
  With the composer's `onPaste` taken out, the first of them fails in Chrome.
- `desktop/nsh/tests/paste_image.rs` (the vendored module's tests, in the app's `cargo test`): PNG,
  JPEG, WebP and GIF untouched with their types; an SVG kept as SVG; BMP and TIFF made PNGs of the
  same pixels; a Windows DIB made a BMP, as GPUI does, converted pixel for pixel; undecodable and
  oversized bitmaps keeping their type.
- `scripts/android-host.sh test`: `PasteReadsTest` (the 128 MiB and 256 MiB bounds; a stream of
  exactly a bound read whole and one byte more refused, on a small scale; a terabyte stream refused
  after one chunk past 128 MiB; declared sizes; the listener with every reason).
- Go: `cmd/mistermorph/consolecmd/console_file_references_test.go` pins the Console's limits to the
  runtime's constants and checks that `.png`, `.jpg` and `.webp` references, and no others, are the
  images the model is shown.

## Platform evidence

"Headless" is nsh's test host handing the field a paste event; "Chrome" is `nsh test --target web`
dispatching a script-made ClipboardEvent in headless Chrome. Neither is the operating system's
clipboard, menu, keyboard shortcut or consent. Nothing below was tried by hand.

Upload results below are the Console's, against a stub agent (Console tests) or the runtime and
proxy in Go tests; "model" is whether the console's agent would put the image into the model's
input. No deployment, ingress, provider call or device memory was measured.

| Platform | Producer and trigger | Expected | Evidence |
| --- | --- | --- | --- |
| Chrome (desktop, Linux), local endpoint stub | script ClipboardEvent, files + text; a 19 MiB PNG | attached in order, text inserted, refusals said; 19,922,944 bytes delivered and attached, model: no (over 5 MiB) | Google Chrome 158.0.8127.88 headless (Linux) via `nsh test --target web`, 6/6 pass |
| Runtime and proxy (Go), local and remote modes | multipart POST /files/upload | 12–19 MB/MiB JPEG/PNG/WebP and 65 MiB stored byte for byte; 128/129 MiB boundaries | `go test` pass; real network ingress NOT TESTED |
| Chrome, real Ctrl+V of a screenshot / Copy Image | user | attached | NOT TESTED |
| Firefox (desktop) | Ctrl+V, context menu Paste | attached | NOT TESTED |
| Safari (macOS) | Command+V, Edit > Paste | attached | NOT TESTED |
| Mobile Chrome / Safari (extra web coverage) | long-press Paste | attached | NOT TESTED |
| Windows desktop app | Snipping Tool / Print Screen, Ctrl+V and right-click Paste | BMP converted to PNG, attached | conversion unit-tested on Linux (DIB → BMP → PNG); NOT TESTED on Windows |
| macOS desktop app | Cmd+Ctrl+Shift+4, Command+V, Edit > Paste, right-click Paste | attached (text-first if both) | NOT TESTED |
| Linux X11 desktop app | screenshot tool, Ctrl+V, right-click Paste | attached | desktop crate builds and its tests pass on Linux; NOT TESTED in a window |
| Linux Wayland desktop app | screenshot tool, Ctrl+V, right-click Paste | attached (text-first if both) | NOT TESTED |
| Android 12+ (API 31+) | long-press Paste, empty and non-empty field | attached | headless only; NOT TESTED on a device |
| Android 12+ | Gboard clipboard chip / image insert | attached (GIF stickers refused) | NOT TESTED |
| Android 8–11 (API 26–30) | long-press Paste, empty and non-empty field | attached, no URI text inserted | patched InputBox compiles against Android 15 APIs and dexes into a stand-in runtime; NOT TESTED on a device |
| iOS 15 | edit menu Paste, empty and non-empty field, screenshot and Photos image | attached / too large said | headless only; NOT TESTED |
| Current iOS | the same, and paste consent allow / deny | attached / nothing | NOT TESTED |

Also unchecked: real 12–19 MB clipboard images on any OS or device (delivered bytes after native
conversion, device memory); deployed ingress limits and timeouts; provider acceptance of the
resulting requests; the packaged Android and iOS runtimes against the 0.6.0 sources read here (the
Android runtime component is not installed on the build machine and `nsh component add` was not
run; the APK was not built); which Android gallery apps offer Copy for a photo; a real Windows DIB
from the Snipping Tool (its header variants: BITMAPV5, bit fields, alpha).
