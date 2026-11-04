import { normalizeTopicID } from "./chat-task-history.js";

function clipboardImageFiles(data) {
  const items = Array.from(data?.items || []).filter(
    (item) => item.kind === "file" && String(item.type || "").startsWith("image/")
  );
  const files = items.length
    ? items.map((item) => item.getAsFile()).filter(Boolean)
    : Array.from(data?.files || []).filter((file) => String(file.type || "").startsWith("image/"));
  return files.map((file, index) => {
    if (file.name) {
      return file;
    }
    const subtype = file.type.slice("image/".length).split("+")[0];
    const extension = subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/gi, "");
    return new File([file], `clipboard-image-${index + 1}.${extension || "img"}`, { type: file.type });
  });
}

function composerFileDraftKey(scope) {
  const endpointRef = String(scope?.endpointRef || "").trim();
  if (!endpointRef) {
    return "";
  }
  return `${endpointRef}\n${normalizeTopicID(scope?.topicID)}`;
}

function composerFileExtension(name) {
  const normalized = String(name || "").trim().toLowerCase();
  const index = normalized.lastIndexOf(".");
  return index >= 0 ? normalized.slice(index) : "";
}

function composerFileReferences(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => String(item?.status || "").trim() === "ready")
    .map((item) => ({
      dir_name: String(item?.dirName || item?.dir_name || "").trim(),
      path: String(item?.path || "").trim(),
    }))
    .filter(
      (reference) =>
        reference.path &&
        (reference.dir_name === "workspace_dir" || reference.dir_name === "file_cache_dir")
    );
}

function buildComposerSubmission(options = {}) {
  const submittedFiles = (Array.isArray(options.files) ? options.files : []).filter(
    (item) => String(item?.status || "").trim() === "ready"
  );
  const fileReferences = composerFileReferences(submittedFiles);
  const requestBody = { task: String(options.task || "").trim() };
  const llmProfile = String(options.llmProfile || "").trim();
  const topicID = normalizeTopicID(options.topicID);
  const workspaceDir = String(options.workspaceDir || "").trim();
  if (llmProfile) {
    requestBody.llm_profile = llmProfile;
  }
  if (fileReferences.length > 0) {
    requestBody.file_references = fileReferences;
  }
  if (topicID) {
    requestBody.topic_id = topicID;
  }
  if (workspaceDir) {
    requestBody.workspace_dir = workspaceDir;
  }
  return { requestBody, submittedFiles, fileReferences };
}

export {
  buildComposerSubmission,
  clipboardImageFiles,
  composerFileDraftKey,
  composerFileExtension,
  composerFileReferences,
};
