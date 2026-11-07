// Row editors for list and map settings. Each mode reads and writes the same draft text the panel
// already uses (one item per line for string lists, pretty JSON for json fields), so parsing,
// validation and the unsaved-change check stay in config-fields.js.
export const ROW_MODES = {
  // string_list: one value per row.
  list: {
    columns: [{ key: "value" }],
    parse(text) {
      return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((value) => ({ value }));
    },
    serialize(rows) {
      return rows.map((row) => row.value.trim()).filter(Boolean).join("\n");
    },
  },
  // json object of strings, e.g. HTTP headers.
  map: {
    columns: [{ key: "name", placeholder: "Name" }, { key: "value", placeholder: "Value" }],
    parse(text) {
      const value = parseJSON(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      // Only a map of strings fits name/value rows; anything else stays in the raw text editor.
      if (Object.values(value).some((item) => typeof item !== "string")) return null;
      return Object.entries(value).map(([name, item]) => ({ name, value: item }));
    },
    serialize(rows) {
      const out = {};
      for (const row of rows) {
        const name = row.name.trim();
        if (name) out[name] = row.value;
      }
      return JSON.stringify(out, null, 2);
    },
  },
  // json array of "NAME" (pass the variable through) or { name, value } (set a fixed value).
  env: {
    columns: [
      { key: "name", placeholder: "NAME" },
      { key: "value", placeholder: "Value (empty passes it through)", secret: true },
    ],
    parse(text) {
      const value = parseJSON(text);
      if (!Array.isArray(value)) return null;
      return value.map((item) => (typeof item === "string"
        ? { name: item, value: "" }
        : { name: String(item?.name ?? ""), value: String(item?.value ?? "") }));
    },
    serialize(rows) {
      const out = [];
      for (const row of rows) {
        const name = row.name.trim();
        if (!name) continue;
        out.push(row.value === "" ? name : { name, value: row.value });
      }
      return JSON.stringify(out, null, 2);
    },
  },
  // json array of { name, re } redaction patterns.
  patterns: {
    columns: [{ key: "name", placeholder: "Name" }, { key: "re", placeholder: "Regular expression", mono: true }],
    parse(text) {
      const value = parseJSON(text);
      if (!Array.isArray(value)) return null;
      return value.map((item) => ({ name: String(item?.name ?? ""), re: String(item?.re ?? "") }));
    },
    serialize(rows) {
      const out = rows
        .filter((row) => row.name.trim() || row.re.trim())
        .map((row) => ({ name: row.name.trim(), re: row.re }));
      return JSON.stringify(out, null, 2);
    },
    rowError(row) {
      if (!row.re.trim()) return "";
      try {
        new RegExp(row.re);
        return "";
      } catch {
        return "Not a valid regular expression.";
      }
    },
  },
  // string_list of "<platform>:<id>" identities; the platform is picked from `platforms`.
  identities: {
    columns: [{ key: "platform", select: true }, { key: "id" }],
    parse(text, platforms) {
      return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const index = line.indexOf(":");
        const prefix = index > 0 ? line.slice(0, index).toLowerCase() : "";
        if (platforms.some((item) => item.value === prefix)) {
          return { platform: prefix, id: line.slice(index + 1) };
        }
        return { platform: "", id: line };
      });
    },
    serialize(rows) {
      return rows
        .filter((row) => row.id.trim())
        .map((row) => (row.platform ? `${row.platform}:${row.id.trim()}` : row.id.trim()))
        .join("\n");
    },
  },
};

function parseJSON(text) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch {
    return undefined;
  }
}
