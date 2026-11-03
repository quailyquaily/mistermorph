const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function canPreviewReceivedFile(file) {
  return RASTER_TYPES.has(file?.content_type);
}

export function receivedFileURL(topicID, taskID, fileID, preview = false) {
  const query = new URLSearchParams({ topic_id: topicID, task_id: taskID, id: fileID });
  if (preview) query.set("preview", "1");
  return `/attachments?${query}`;
}
