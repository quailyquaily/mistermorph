function relativeLuminance(red, green, blue) {
  const linear = [red, green, blue].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function avatarAccentColor(image, background) {
  if (!image.naturalWidth || !image.naturalHeight || !background) return "";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return "";

    context.fillStyle = background;
    context.fillRect(0, 0, 1, 1);
    const backdrop = context.getImageData(0, 0, 1, 1).data;
    if (backdrop[3] !== 255) return "";
    const backgroundLuminance = relativeLuminance(...backdrop);
    // Contrast must not affect which hue wins the area count.
    const hasContrast = (luminance) =>
      (Math.max(luminance, backgroundLuminance) + 0.05) /
      (Math.min(luminance, backgroundLuminance) + 0.05) >= 1.5;

    // Sample the same circular, center-cropped area shown by the avatar.
    context.clearRect(0, 0, 32, 32);
    context.beginPath();
    context.arc(16, 16, 16, 0, Math.PI * 2);
    context.clip();
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2,
      side, side, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    const hues = new Map();
    let visiblePixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] < 192) continue;
      visiblePixels++;
      const [red, green, blue] = pixels.subarray(offset, offset + 3);
      const maximum = Math.max(red, green, blue);
      const chroma = maximum - Math.min(red, green, blue);
      if (maximum < 48 || chroma < 36) continue;

      const hue = maximum === red ? (green - blue) / chroma
        : maximum === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
      const key = Math.round(((hue + 6) % 6) * 2) % 12;
      const bucket = hues.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
      bucket.count++;
      bucket.red += red;
      bucket.green += green;
      bucket.blue += blue;
      hues.set(key, bucket);
    }
    const dominant = [...hues.values()].sort((left, right) => right.count - left.count)[0];
    // A tiny colored detail should not determine an otherwise neutral avatar's accent.
    if (!dominant || dominant.count < visiblePixels * 0.1) return "";
    const rgb = [dominant.red, dominant.green, dominant.blue].map((value) => Math.round(value / dominant.count));
    // Retain the hue, allowing at most a 20% mix toward black or white for visibility.
    const target = backgroundLuminance > 0.5 ? 0 : 255;
    for (let step = 0; step <= 10; step++) {
      const adjusted = rgb.map((channel) => Math.round(channel + (target - channel) * step * 0.02));
      if (hasContrast(relativeLuminance(...adjusted))) return `rgb(${adjusted.join(" ")})`;
    }
    return "";
  } catch {
    // Cross-origin or unreadable images keep the theme's default accent.
    return "";
  }
}
