import assert from "node:assert/strict";
import test from "node:test";

import { formatDate, formatNumber } from "./intl-format.js";

const DATES = [new Date(2026, 9, 24, 9, 5), new Date(2025, 0, 3, 23, 59), new Date(2026, 11, 31, 0, 0)];
const LOCALES = ["en-US", "en-GB", "zh-CN", "ja-JP", "", "not-a-locale-%%"];

test("cached date formats read exactly as toLocale*String did", () => {
  const cases = [
    { method: "toLocaleTimeString", options: { hour: "2-digit", minute: "2-digit" } },
    { method: "toLocaleDateString", options: { month: "short", day: "numeric" } },
    { method: "toLocaleDateString", options: { year: "numeric", month: "short", day: "numeric" } },
    { method: "toLocaleString", options: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } },
  ];
  for (const { method, options } of cases) {
    for (const locale of LOCALES) {
      for (const date of DATES) {
        let want;
        try {
          want = date[method](locale || undefined, options);
        } catch {
          want = date[method](undefined, options);
        }
        assert.equal(formatDate(date, locale, options), want, `${method} ${locale} ${JSON.stringify(options)}`);
      }
    }
  }
});

test("cached number formats read exactly as toLocaleString did", () => {
  for (const locale of ["en-US", "de-DE", "ja-JP", "zh-CN"]) {
    for (const value of [0, 7, 1234, 9876543]) {
      assert.equal(formatNumber(value, locale), value.toLocaleString(locale), `${locale} ${value}`);
    }
  }
});
