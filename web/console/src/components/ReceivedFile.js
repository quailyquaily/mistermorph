import { h, onBeforeUnmount, ref, watch } from "vue";
import AppButton from "./ui/AppButton.js";
import { canPreviewReceivedFile, receivedFileURL } from "../core/received-files.js";

export default {
  props: {
    file: { type: Object, required: true },
    taskId: { type: String, required: true },
    topicId: { type: String, required: true },
    fetchBlob: { type: Function, required: true },
    downloadLabel: { type: String, default: "Download" },
    errorLabel: { type: String, default: "Preview unavailable. You can still download the file." },
  },
  setup(props) {
    const previewURL = ref("");
    const error = ref("");
    const busy = ref(false);
    let generation = 0;
    function clearPreview() {
      if (previewURL.value) URL.revokeObjectURL(previewURL.value);
      previewURL.value = "";
    }
    watch(() => [props.file.id, props.file.content_type, props.taskId, props.topicId], async (_, __, onCleanup) => {
      const current = ++generation;
      const abort = new AbortController();
      onCleanup(() => abort.abort());
      clearPreview();
      error.value = "";
      if (!canPreviewReceivedFile(props.file)) return;
      try {
        const blob = await props.fetchBlob(receivedFileURL(props.topicId, props.taskId, props.file.id, true), { signal: abort.signal });
        if (current === generation && !abort.signal.aborted) {
          if (blob.type !== props.file.content_type) throw new Error(props.errorLabel);
          previewURL.value = URL.createObjectURL(blob);
        }
      } catch (err) {
        if (current === generation && !abort.signal.aborted) error.value = props.errorLabel;
      }
    }, { immediate: true });
    onBeforeUnmount(() => { generation++; clearPreview(); });

    async function download() {
      if (busy.value) return;
      busy.value = true;
      error.value = "";
      try {
        const blob = await props.fetchBlob(receivedFileURL(props.topicId, props.taskId, props.file.id));
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = props.file.name;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        error.value = err?.message || "Download failed";
      } finally {
        busy.value = false;
      }
    }
    return () => h("section", { class: "received-file", "aria-label": props.file.name }, [
      h("div", { class: "received-file-heading" }, [
        h("span", { class: "received-file-name" }, props.file.name),
        h(AppButton, { type: "button", class: "outlined xs", loading: busy.value, onClick: download }, () => props.downloadLabel),
      ]),
      previewURL.value ? h("img", {
        class: "received-file-image", src: previewURL.value, alt: props.file.name,
        onError: () => { clearPreview(); error.value = props.errorLabel; },
      }) : null,
      error.value ? h("p", { role: "status", class: "received-file-error" }, error.value) : null,
    ]);
  },
};
