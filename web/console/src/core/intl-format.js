// Cached Intl formatters. Date#toLocaleString and Number#toLocaleString with a locale or options
// build a new Intl formatter on every call, which costs far more than the formatting itself; the
// chat formats every topic's and message's time on each render, and a streaming reply re-renders it
// many times a second. These keep one formatter per locale and options instead.
//
// Pass the options that the toLocale* call took, with its date or time fields spelled out: an
// Intl.DateTimeFormat does not add toLocaleTimeString's or toLocaleDateString's defaults.

const dateFormats = new Map();
const numberFormats = new Map();

function cached(cache, Make, locale, options) {
  const key = `${locale || ""}|${JSON.stringify(options || {})}`;
  let format = cache.get(key);
  if (!format) {
    try {
      format = new Make(locale || undefined, options);
    } catch {
      // An unknown locale tag: fall back to the default locale rather than failing the render.
      format = new Make(undefined, options);
    }
    cache.set(key, format);
  }
  return format;
}

export function formatDate(date, locale, options) {
  return cached(dateFormats, Intl.DateTimeFormat, locale, options).format(date);
}

export function formatNumber(value, locale, options) {
  return cached(numberFormats, Intl.NumberFormat, locale, options).format(value);
}
