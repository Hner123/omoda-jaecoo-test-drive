// Optional artwork must never keep a customer waiting indefinitely or taint the canvas.
function loadTicketArtwork(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    let url;
    try {
      url = new URL(src, location.origin);
      if (url.origin !== location.origin) return resolve(null);
    } catch { return resolve(null); }
    const image = new Image();
    const finish = (value) => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 3000);
    image.onload = () => finish(image.naturalWidth ? image : null);
    image.onerror = () => finish(null);
    image.src = url.href;
  });
}

// Explicit allowlist: no registration object, DOM text, or page URL is rendered.
async function drawTicketImage({ number, firstName, modelName, createdAt, carImage }) {
  const [logo, car] = await Promise.all([
    loadTicketArtwork('/img/logo.png'), loadTicketArtwork(carImage),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1600;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  const supportsFilters = typeof ctx.filter === 'string';
  ctx.scale(2, 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 540, 800);
  ctx.fillStyle = '#06b6d4';
  ctx.fillRect(0, 0, 540, 8);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const font = (size, weight) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const text = (value, y, size = 18, color = '#1f2933', weight = 400) => {
    const label = String(value ?? '');
    ctx.font = font(size, weight);
    while (ctx.measureText(label).width > 444 && size > 10) ctx.font = font(--size, weight);
    ctx.fillStyle = color;
    ctx.fillText(label, 270, y, 444);
  };
  const artwork = (image, x, y, width, height) => {
    const ratio = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const w = image.naturalWidth * ratio;
    const h = image.naturalHeight * ratio;
    ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
  };
  if (logo && supportsFilters) {
    try {
      ctx.save();
      ctx.filter = 'brightness(0)';
      artwork(logo, 90, 40, 360, 44);
    } catch {
      text('OMODA & JAECOO', 62, 28, '#1f2933', 600);
    } finally { ctx.restore(); }
  } else text('OMODA & JAECOO', 62, 28, '#1f2933', 600);
  text('Test Drive', 122, 30, '#1f2933', 600);
  text('Auto Focus Test Drive Festival', 160, 16, '#5f6b76');
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(32, 200, 476, 150);
  text('Queue number', 230, 17, '#5f6b76');
  text(number, 294, 68, '#0e7490', 600);
  text(modelName, 390, 26, '#1f2933', 600);
  if (car) {
    try { artwork(car, 48, 422, 444, 166); } catch { /* Artwork is optional. */ }
  }
  text(firstName, 614, 24, '#1f2933', 600);
  const date = new Date(createdAt);
  text(Number.isNaN(date.getTime()) ? 'Registration time unavailable' :
    date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), 650, 16, '#5f6b76');
  ctx.fillStyle = '#dfe3e8';
  ctx.fillRect(48, 682, 444, 1);
  text('Show this ticket at the OMODA JAECOO Booth.', 710, 16);
  text('Listen for your number on the lobby screen.', 736, 16, '#5f6b76');
  text("We'll also text you when it's your turn.", 762, 16, '#5f6b76');
  return canvas;
}

async function saveTicketImage(data) {
  const canvas = await drawTicketImage(data);
  const blob = await new Promise((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error('PNG export failed')), 'image/png'));
  const filename = `OMODA-JAECOO-ticket-${data.number}.png`;
  try {
    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'My test drive ticket' });
      return;
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Allow the browser to start consuming the download before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
