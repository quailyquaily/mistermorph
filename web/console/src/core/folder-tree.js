// A lazily loaded folder tree: items holds each loaded folder's entries by path ("" is the root),
// expanded holds the open folders. Shared by the chat's workspace panel and the folder browser.

export function hasOwnTreePath(map, path) {
  return Boolean(map) && Object.prototype.hasOwnProperty.call(map, path);
}

export function normalizeTreeItems(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => ({
      name: String(item?.name || "").trim(),
      path: String(item?.path || "").trim(),
      is_dir: item?.is_dir === true,
      has_children: item?.has_children === true,
      size_bytes: Number.isFinite(Number(item?.size_bytes)) ? Math.trunc(Number(item.size_bytes)) : -1,
    }))
    .filter((item) => item.name && item.path);
}

export function buildTreeRows(itemsByPath, expandedByPath, parentPath = "", depth = 0) {
  const items = Array.isArray(itemsByPath?.[parentPath]) ? itemsByPath[parentPath] : [];
  const rows = [];
  for (const entry of items) {
    const entryPath = String(entry?.path || "").trim();
    const hasLoadedChildren = hasOwnTreePath(itemsByPath, entryPath);
    const hasVisibleChildren = hasLoadedChildren && Array.isArray(itemsByPath?.[entryPath]) && itemsByPath[entryPath].length > 0;
    const expandable = Boolean(entry?.is_dir) && (entry?.has_children || hasVisibleChildren);
    const expanded = expandable && expandedByPath?.[entryPath] === true;
    rows.push({
      key: `${parentPath}:${entryPath}`,
      depth,
      entry,
      expandable,
      expanded,
    });
    if (expandable && expanded && hasLoadedChildren) {
      rows.push(...buildTreeRows(itemsByPath, expandedByPath, entryPath, depth + 1));
    }
  }
  return rows;
}

export function setTreeItems(target, path, items) {
  target.value = {
    ...target.value,
    [path]: normalizeTreeItems(items),
  };
}

export function setTreeExpanded(target, path, expanded) {
  const nextValue = { ...target.value };
  if (expanded) {
    nextValue[path] = true;
  } else {
    delete nextValue[path];
  }
  target.value = nextValue;
}
