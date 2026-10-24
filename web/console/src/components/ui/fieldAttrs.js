import { Comment, Fragment, Text } from "vue";

// fieldAttrs splits a form component's fallthrough attributes: class, style and data-* stay on its
// root (the app styles and finds fields by them); the rest, aria-*, name, id, autocomplete, min, step,
// listeners and so on, go to the native field, where they take effect.
function fieldAttrs(attrs) {
  const root = {};
  const field = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class" || key === "style" || key.startsWith("data-")) {
      root[key] = value;
    } else {
      field[key] = value;
    }
  }
  return { root, field };
}

// hasSlotContent reports whether a slot renders anything but comments and whitespace.
function hasSlotContent(slot) {
  const visible = (nodes) =>
    nodes.some((node) => {
      if (node.type === Comment) return false;
      if (node.type === Text) return typeof node.children !== "string" || node.children.trim().length > 0;
      if (node.type === Fragment && Array.isArray(node.children)) return visible(node.children);
      return true;
    });
  return slot ? visible(slot()) : false;
}

export { fieldAttrs, hasSlotContent };
