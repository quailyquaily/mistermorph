// An image picked, adjusted and saved (the Vue console's ImageUploadField and ImageAdjustDialog):
// the preview opens a dialog to delete or replace the image; a picked image opens the adjust
// dialog (drag to move, zoom 100–400 %, a square crop when `crop`).
//
// Vue to nsh: `save` is `onSave(image)`, `delete` is `onDelete()`; the adjust dialog's
// `modelValue` is `open` with `onOpenChange(open)`.
//
// The bytes of a picked file stay in the host (lib/platform.ts), and an nsh Canvas draws but cannot
// export pixels, so the app cannot re-encode the image as the Vue dialog did. `onSave` gets the
// picked file with the cut the user chose (`crop`, in the image's pixels) and the output asked for;
// `uploadAdjustedImage` sends both to the host, which applies the cut and the encoding once it
// supports the upload's `image` option (see the report). Until then the host sends the file as
// picked.
import { Buffer } from "buffer";
import type { ImageAsset } from "nsh";
import { Canvas, effect, Image, PanResponder, signal, Text, untracked, View } from "nsh";
import { pushNotice } from "../../lib/core/notices.js";
import { type PickedFile, pickFiles, releaseFile, type UploadResult, type UploadTarget, uploadFile } from "../../lib/platform";
import { Button, Icon, ProgressBar } from "../ui";
import { DialogShell, t } from "./DialogShell";
import { SettingDialog } from "./SettingDialog";

const DEFAULT_SOURCE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const PREVIEW_MAX_SIZE = 360;
const PREVIEW_MIN_SIZE = 180;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.14;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const numeric = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

/** The picked image and how to cut it: the source rectangle in image pixels and the output. */
export interface AdjustedImage {
  file: PickedFile;
  crop: { sx: number; sy: number; sw: number; sh: number };
  width: number;
  height: number;
  type: string;
  quality: number;
}

/**
 * Uploads an adjusted image: the file, with the cut and the encoding as the upload's `image`
 * option for the host to apply (`morph.file.upload`).
 */
export async function uploadAdjustedImage(image: AdjustedImage, target: UploadTarget): Promise<UploadResult> {
  const { file, ...transform } = image;
  return await uploadFile(file, { ...target, image: transform } as UploadTarget);
}

/** An SVG's markup as a URL an Image shows. */
function svgDataURL(markup: string) {
  return `data:image/svg+xml;base64,${Buffer.from(markup, "utf8").toString("base64")}`;
}

export interface ImageUploadFieldProps {
  previewUrl?: string;
  /** An SVG shown when there is no image (the Vue `defaultMarkup`). */
  defaultMarkup?: string;
  /** An image asset shown when there is no image, in place of `defaultMarkup` (the app's logo). */
  defaultImage?: ImageAsset;
  /** The preview's side in points (Vue: 96 for the persona avatar). */
  previewSize?: number;
  disabled?: boolean;
  busy?: boolean;
  /** Square output, filling the frame. */
  crop?: boolean;
  outputSize?: number;
  outputType?: string;
  outputQuality?: number;
  dialogTitle?: string;
  accept?: string;
  allowedTypes?: string[];
  maxBytes?: number;
  onSave?: (image: AdjustedImage) => void;
  onDelete?: () => void;
  testID?: string;
}

/**
 * The image, the default logo (68% of the frame, `.image-upload-logo`), or a cube when there is
 * neither.
 */
function ImageFace(props: { previewUrl?: string; defaultMarkup?: string; defaultImage?: ImageAsset; size: number }) {
  const logo = () => Math.round(props.size * 0.68);
  return (
    <If
      when={props.previewUrl}
      else={
        <If
          when={props.defaultImage}
          else={
            <If when={props.defaultMarkup} else={<Icon name="PhCube" size={Math.round(props.size / 3.4)} color="muted-foreground" />}>
              <Image src={svgDataURL(props.defaultMarkup ?? "")} accessibilityElementsHidden style={{ width: logo(), height: logo() }} />
            </If>
          }
        >
          <Image src={props.defaultImage!} accessibilityElementsHidden style={{ width: logo(), height: logo() }} />
        </If>
      }
    >
      <Image src={props.previewUrl} accessibilityElementsHidden style={{ width: props.size, height: props.size }} />
    </If>
  );
}

export function ImageUploadField(props: ImageUploadFieldProps) {
  const selectedFile = signal<PickedFile | null>(null);
  const adjustDialogOpen = signal(false);
  const previewDialogOpen = signal(false);
  const previewTitle = () => String(props.dialogTitle || "").trim() || t("image_upload_preview_title");
  const blocked = () => untracked(() => !!props.disabled || !!props.busy);

  function clearSelection() {
    const file = untracked(selectedFile);
    if (file) releaseFile(file);
    selectedFile.set(null);
  }

  function openPreviewDialog() {
    if (blocked()) return;
    previewDialogOpen.set(true);
  }

  function validateFile(file: PickedFile | undefined) {
    if (!file) return false;
    const allowed = untracked(() => (Array.isArray(props.allowedTypes) ? props.allowedTypes : DEFAULT_SOURCE_TYPES));
    if (allowed.length > 0 && !allowed.includes(file.type)) {
      pushNotice({ type: "error", text: t("image_upload_error_type") });
      return false;
    }
    const maxBytes = untracked(() => Number(props.maxBytes ?? DEFAULT_MAX_BYTES));
    if (maxBytes > 0 && file.size > maxBytes) {
      pushNotice({ type: "error", text: t("image_upload_error_size") });
      return false;
    }
    return true;
  }

  async function openFilePicker() {
    if (blocked()) return;
    let files: PickedFile[];
    try {
      files = await pickFiles({ accept: untracked(() => props.accept || DEFAULT_SOURCE_TYPES.join(",")), multiple: false });
    } catch (error) {
      pushNotice({ type: "error", text: (error as Error)?.message || t("image_adjust_error_load") });
      return;
    }
    const file = files?.[0];
    if (!file) return;
    if (!validateFile(file)) {
      releaseFile(file);
      return;
    }
    clearSelection();
    selectedFile.set(file);
    previewDialogOpen.set(false);
    adjustDialogOpen.set(true);
  }

  function saveAdjustedImage(image: AdjustedImage) {
    props.onSave?.(image);
    // The file stays in the host until the page has uploaded it; it goes with the next pick.
    selectedFile.set(null);
  }

  function deleteImage() {
    if (blocked()) return;
    clearSelection();
    previewDialogOpen.set(false);
    props.onDelete?.();
  }

  // Closing the adjust dialog drops the picked file.
  let wasOpen = false;
  effect(() => {
    const open = adjustDialogOpen();
    untracked(() => {
      if (wasOpen && !open && selectedFile()) clearSelection();
      wasOpen = open;
    });
  });

  return (
    <View testID={props.testID ?? "image-upload"}>
      <View
        role="button"
        accessibilityLabel={previewTitle()}
        disabled={props.disabled || props.busy}
        onPress={openPreviewDialog}
        class="items-center justify-center overflow-hidden rounded-[8px] border border-transparent transition-colors duration-120 hover:border-blue/45 hover:shadow-[0_0_0_3px_rgba(66,111,158,0.12)] disabled:opacity-70"
        style={{ width: props.previewSize ?? 96, height: props.previewSize ?? 96 }}
        testID="image-upload-preview"
      >
        <ImageFace previewUrl={props.previewUrl} defaultMarkup={props.defaultMarkup} defaultImage={props.defaultImage} size={props.previewSize ?? 96} />
      </View>

      <DialogShell
        open={previewDialogOpen()}
        title={previewTitle()}
        size="sm"
        closeDisabled={props.busy}
        onClose={() => previewDialogOpen.set(false)}
        testID="image-upload-dialog"
      >
        <View class="items-center gap-4">
          <View class="size-[300px] max-w-full items-center justify-center overflow-hidden rounded-[8px] border border-line-faint bg-paper">
            <ImageFace previewUrl={props.previewUrl} defaultMarkup={props.defaultMarkup} defaultImage={props.defaultImage} size={300} />
          </View>
          <View class="flex-row gap-2">
            <Button
              variant="danger"
              label={t("action_delete")}
              disabled={props.disabled || props.busy || !props.previewUrl}
              onPress={deleteImage}
              testID="image-upload-delete"
            />
            <Button
              variant="outlined"
              label={t("image_upload_action_replace")}
              disabled={props.disabled || props.busy}
              onPress={() => void openFilePicker()}
              testID="image-upload-replace"
            />
          </View>
        </View>
      </DialogShell>

      <ImageAdjustDialog
        open={adjustDialogOpen()}
        onOpenChange={(open) => adjustDialogOpen.set(open)}
        file={selectedFile()}
        title={props.dialogTitle}
        crop={props.crop}
        outputSize={props.outputSize}
        outputType={props.outputType}
        outputQuality={props.outputQuality}
        busy={props.busy}
        onSave={saveAdjustedImage}
      />
    </View>
  );
}

export interface ImageAdjustDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  file: PickedFile | null;
  title?: string;
  crop?: boolean;
  outputSize?: number;
  outputType?: string;
  outputQuality?: number;
  busy?: boolean;
  onSave?: (image: AdjustedImage) => void;
}

export function ImageAdjustDialog(props: ImageAdjustDialogProps) {
  const loading = signal(false);
  const natural = signal<{ width: number; height: number } | null>(null);
  const zoom = signal(1);
  const offset = signal({ x: 0, y: 0 });
  const dragging = signal(false);
  let loadToken = 0;
  let dragStart = { x: 0, y: 0 };

  const imageReady = () => natural() !== null;
  const resolvedTitle = () => String(props.title || "").trim() || t("image_adjust_title");
  const zoomPercent = () => `${Math.round(zoom() * 100)}%`;

  /** The frame: square when cropping, else the image's shape within 180–360 points. */
  const viewport = () => {
    const size = natural();
    if (!size || props.crop) return { width: 320, height: 320 };
    const ratio = size.width / size.height;
    if (!Number.isFinite(ratio) || ratio <= 0) return { width: 320, height: 320 };
    if (ratio >= 1) return { width: PREVIEW_MAX_SIZE, height: Math.max(PREVIEW_MIN_SIZE, Math.round(PREVIEW_MAX_SIZE / ratio)) };
    return { width: Math.max(PREVIEW_MIN_SIZE, Math.round(PREVIEW_MAX_SIZE * ratio)), height: PREVIEW_MAX_SIZE };
  };

  const scaleFor = (viewWidth: number, viewHeight: number, zoomValue: number) => {
    const size = untracked(natural);
    if (!size) return 1;
    const fit = untracked(() => props.crop)
      ? Math.max(viewWidth / size.width, viewHeight / size.height)
      : Math.min(viewWidth / size.width, viewHeight / size.height);
    return fit * zoomValue;
  };

  /** How far the image may move from the centre at `zoomValue`. */
  const bounds = (zoomValue: number) => {
    const size = untracked(natural);
    const view = untracked(viewport);
    if (!size) return { x: 0, y: 0 };
    const scale = scaleFor(view.width, view.height, zoomValue);
    return {
      x: Math.max(0, (size.width * scale - view.width) / 2),
      y: Math.max(0, (size.height * scale - view.height) / 2),
    };
  };

  const clampOffset = (next: { x: number; y: number }, zoomValue = untracked(zoom)) => {
    const limit = bounds(zoomValue);
    return { x: clamp(next.x, -limit.x, limit.x), y: clamp(next.y, -limit.y, limit.y) };
  };

  // A new file (or a reopened dialog) loads its size and starts centred at 100 %.
  effect(() => {
    const open = props.open;
    const file = props.file;
    void props.crop;
    untracked(() => {
      loadToken += 1;
      natural.set(null);
      zoom.set(1);
      offset.set({ x: 0, y: 0 });
      dragging.set(false);
      loading.set(false);
      if (!open || !file) return;
      if (!file.preview) {
        pushNotice({ type: "error", text: t("image_adjust_error_load") });
        return;
      }
      const token = loadToken;
      loading.set(true);
      Image.getSize(file.preview).then(
        (size) => {
          if (token !== loadToken) return;
          natural.set({ width: size.width, height: size.height });
          loading.set(false);
        },
        (error: Error) => {
          if (token !== loadToken) return;
          console.warn("could not load the picked image:", error?.message || error);
          loading.set(false);
          pushNotice({ type: "error", text: t("image_adjust_error_load") });
        },
      );
    });
  });

  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => untracked(imageReady) && !untracked(() => props.busy),
    onMoveShouldSetPanResponder: () => untracked(imageReady) && !untracked(() => props.busy),
    onPanResponderGrant: () => {
      dragStart = untracked(offset);
      dragging.set(true);
    },
    onPanResponderMove: (_event, gesture) => {
      offset.set(clampOffset({ x: dragStart.x + gesture.dx, y: dragStart.y + gesture.dy }));
    },
    onPanResponderRelease: () => dragging.set(false),
    onPanResponderTerminate: () => dragging.set(false),
  });

  function setZoom(next: number) {
    if (!untracked(imageReady) || untracked(() => props.busy)) return;
    const value = clamp(next, MIN_ZOOM, MAX_ZOOM);
    zoom.set(value);
    offset.set(clampOffset(untracked(offset), value));
  }

  /** The output's size: square when cropping, else the image's, scaled down to `outputSize`. */
  function outputDimensions() {
    const size = numeric(untracked(() => props.outputSize), 1024);
    const image = untracked(natural);
    if (untracked(() => props.crop) || !image) return { width: size, height: size };
    const naturalMax = Math.max(image.width, image.height);
    const scale = naturalMax > size ? size / naturalMax : 1;
    return { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) };
  }

  function saveImage() {
    const file = untracked(() => props.file);
    const size = untracked(natural);
    if (!file || !size || untracked(() => props.busy)) return;
    const view = untracked(viewport);
    const scale = scaleFor(view.width, view.height, untracked(zoom));
    const position = untracked(offset);
    const drawX = (view.width - size.width * scale) / 2 + position.x;
    const drawY = (view.height - size.height * scale) / 2 + position.y;
    const output = outputDimensions();
    props.onSave?.({
      file,
      crop: { sx: -drawX / scale, sy: -drawY / scale, sw: view.width / scale, sh: view.height / scale },
      width: output.width,
      height: output.height,
      type: untracked(() => props.outputType) || "image/webp",
      quality: clamp(Number(untracked(() => props.outputQuality)) || 0.9, 0.1, 1),
    });
    props.onOpenChange?.(false);
  }

  return (
    <SettingDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && untracked(() => props.busy)) return;
        props.onOpenChange?.(open);
      }}
      title={resolvedTitle()}
      size="md"
      saving={props.busy}
      saveDisabled={props.busy || !imageReady()}
      onSave={saveImage}
      testID="image-adjust-dialog"
    >
      <View class="items-center gap-3">
        <View
          {...pan.panHandlers}
          role="image"
          accessibilityLabel={t("image_adjust_canvas_label")}
          class={`overflow-hidden rounded-(--radius) border border-line-faint bg-paper ${dragging() ? "opacity-90" : ""}`}
          style={{ width: viewport().width, height: viewport().height }}
          testID="image-adjust-stage"
        >
          <Canvas
            class="flex-1 self-stretch"
            draw={(cx, area) => {
              const file = props.file;
              const size = natural();
              if (!file?.preview || !size) return;
              const view = viewport();
              const fit = props.crop
                ? Math.max(view.width / size.width, view.height / size.height)
                : Math.min(view.width / size.width, view.height / size.height);
              const scale = fit * zoom();
              const position = offset();
              const sx = area.width / view.width;
              const sy = area.height / view.height;
              const width = size.width * scale;
              const height = size.height * scale;
              cx.drawImage(
                file.preview,
                ((view.width - width) / 2 + position.x) * sx,
                ((view.height - height) / 2 + position.y) * sy,
                width * sx,
                height * sy,
              );
            }}
          />
          <If when={loading()}>
            <View class="absolute bottom-0 left-0 right-0">
              <ProgressBar indeterminate />
            </View>
          </If>
        </View>
        <View class="flex-row items-center gap-2">
          <Button
            variant="outlined"
            iconOnly
            title={t("image_adjust_zoom_out")}
            disabled={props.busy || !imageReady()}
            onPress={() => setZoom(untracked(zoom) / ZOOM_STEP)}
            testID="image-adjust-zoom-out"
          >
            <Text class="text-base font-medium text-foreground">-</Text>
          </Button>
          <Text class="w-14 text-center font-mono text-sm text-foreground" testID="image-adjust-zoom">
            {zoomPercent()}
          </Text>
          <Button
            variant="outlined"
            iconOnly
            icon="PhPlus"
            title={t("image_adjust_zoom_in")}
            disabled={props.busy || !imageReady()}
            onPress={() => setZoom(untracked(zoom) * ZOOM_STEP)}
            testID="image-adjust-zoom-in"
          />
        </View>
      </View>
    </SettingDialog>
  );
}
