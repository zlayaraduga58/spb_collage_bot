require('dotenv').config();
const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set. Create a .env file with your token.');
  process.exit(1);
}

const bot = new Telegraf(TOKEN);

const CANVAS_SIZE   = 1080;
const MIN_SPACING   = 10;
const OUTER_PADDING = 45;
const CORNER_RADIUS = 10;
const LOGO_WIDTH    = 230;
const LOGO_PADDING  = 45;
const TEMP_DIR      = path.join(__dirname, 'temp');

// Two background themes — one is chosen randomly per render
const THEMES = [
  { bg: { r: 86,  g: 124, b: 147, alpha: 1 }, logo: 'logo_dark.png'  }, // #567c93
  { bg: { r: 37,  g: 59,  b: 72,  alpha: 1 }, logo: 'logo_light.png' }, // #253b48
];

function pickTheme() {
  return THEMES[Math.floor(Math.random() * THEMES.length)];
}

// ─── Cluster layout ─────────────────────────────────────────────────────────
// Multiple candidate row groupings per count.
// The best one is selected at runtime based on actual image aspect ratios,
// maximising both height fill (layout uses as much of gridH as possible)
// and row width fill (no single very-narrow row).
const CANDIDATE_GROUPS = {
  1:  [ [[0]] ],
  2:  [ [[0, 1]] ],
  3:  [ [[0, 1], [2]],
        [[0], [1, 2]],
        [[0, 1, 2]] ],
  4:  [ [[0, 1], [2, 3]],
        [[0, 1, 2], [3]],
        [[0, 1, 2, 3]] ],
  5:  [ [[0, 1], [2, 3, 4]],
        [[0, 1, 2], [3, 4]],
        [[0, 1, 2, 3], [4]] ],
  6:  [ [[0, 1, 2], [3, 4, 5]],
        [[0, 1], [2, 3], [4, 5]],
        [[0, 1, 2, 3], [4, 5]] ],
  7:  [ [[0, 1, 2], [3, 4], [5, 6]],
        [[0, 1], [2, 3, 4], [5, 6]],
        [[0, 1, 2], [3, 4, 5], [6]] ],
  8:  [ [[0, 1, 2], [3, 4, 5], [6, 7]],
        [[0, 1], [2, 3, 4], [5, 6, 7]],
        [[0, 1, 2], [3, 4], [5, 6, 7]] ],
  9:  [ [[0, 1, 2], [3, 4, 5], [6, 7, 8]],
        [[0, 1], [2, 3, 4], [5, 6], [7, 8]] ],
  10: [ [[0, 1, 2], [3, 4, 5], [6, 7, 8, 9]],
        [[0, 1], [2, 3, 4], [5, 6, 7], [8, 9]],
        [[0, 1, 2, 3], [4, 5, 6], [7, 8, 9]] ],
};

// Fallback rigid grid [cols, rows] when cluster layout errors out
const GRID_LAYOUTS = {
  1:[1,1], 2:[2,1], 3:[2,2], 4:[2,2],
  5:[3,2], 6:[3,2], 7:[3,3], 8:[3,3], 9:[3,3], 10:[4,3],
};

const sessions = {};
const SESSION_TIMEOUT_MS = 2500;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function downloadFile(url, destPath) {
  const response = await axios({ url, method: 'GET', responseType: 'arraybuffer' });
  fs.writeFileSync(destPath, response.data);
}

function cleanFiles(filePaths) {
  for (const fp of filePaths) { try { fs.unlinkSync(fp); } catch (_) {} }
}

// Get true aspect ratio after EXIF auto-rotation (cheap: resize to thumbnail first)
async function getAspectRatio(imgPath) {
  const buf = await sharp(imgPath)
    .rotate()
    .resize(200, 200, { fit: 'inside' })
    .toBuffer();
  const { width, height } = await sharp(buf).metadata();
  return width / height;
}

// Apply rounded corners via SVG mask (dest-in blend)
async function applyRoundedCorners(imgBuf, w, h, radius) {
  const svg = `<svg width="${w}" height="${h}">
    <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}"/>
  </svg>`;
  const mask = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(imgBuf)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

// ─── Cluster layout — scored candidate selection ─────────────────────────────
// Score a row grouping against the actual image aspect ratios.
// Rewards: totalH close to gridH (height fill) AND all rows wide (no narrow rows).
function scoreGrouping(aspectRatios, rowGroups, gridW, gridH) {
  const MAX_ROW_H = gridH * 0.70;
  let totalH = 0;
  let minWidthRatio = 1.0;

  for (const group of rowGroups) {
    const arSum  = group.map(i => aspectRatios[i]).reduce((a, b) => a + b, 0);
    const rowH   = Math.min((gridW - MIN_SPACING * (group.length - 1)) / arSum, MAX_ROW_H);
    const rowW   = group.map(i => aspectRatios[i]).reduce((a, b) => a + b, 0) * rowH
                   + MIN_SPACING * (group.length - 1);
    totalH      += rowH;
    minWidthRatio = Math.min(minWidthRatio, rowW / gridW);
  }
  totalH += MIN_SPACING * (rowGroups.length - 1);

  const heightScore = totalH <= gridH ? totalH / gridH : gridH / totalH;
  return heightScore * minWidthRatio;
}

function computeClusterLayout(aspectRatios, candidates, gridW, gridH) {
  // 1. Pick the candidate grouping that best fills the canvas for these images
  let rowGroups = candidates[0], bestScore = -1;
  for (const cand of candidates) {
    const s = scoreGrouping(aspectRatios, cand, gridW, gridH);
    if (s > bestScore) { bestScore = s; rowGroups = cand; }
  }

  const numRows  = rowGroups.length;
  // Cap: no single row taller than 70 % of gridH (only for multi-row layouts)
  const MAX_ROW_H = numRows > 1 ? gridH * 0.70 : gridH;

  // 2. Content-justified row heights (each row fills gridW) with height cap
  const rows = rowGroups.map(group => {
    const ars   = group.map(i => aspectRatios[i]);
    const arSum = ars.reduce((a, b) => a + b, 0);
    const rowH  = Math.min((gridW - MIN_SPACING * (group.length - 1)) / arSum, MAX_ROW_H);
    return { group, rowH, widths: ars.map(ar => ar * rowH) };
  });

  // 3. Scale down if total still exceeds gridH (safety net after capping)
  const totalH = rows.reduce((s, r) => s + r.rowH, 0) + MIN_SPACING * (numRows - 1);
  if (totalH > gridH) {
    const scale = gridH / totalH;
    rows.forEach(r => { r.rowH *= scale; r.widths = r.widths.map(w => w * scale); });
  }

  // 4. Assign positions — vertically centered, each row horizontally centered
  const scaledTotalH = rows.reduce((s, r) => s + r.rowH, 0) + MIN_SPACING * (numRows - 1);
  let currentY = (gridH - scaledTotalH) / 2;
  const placements = new Array(aspectRatios.length);

  rows.forEach(({ group, rowH, widths }) => {
    const rowW   = widths.reduce((a, b) => a + b, 0) + MIN_SPACING * (group.length - 1);
    let currentX = (gridW - rowW) / 2;
    group.forEach((imgIdx, j) => {
      placements[imgIdx] = { slotX: currentX, slotY: currentY, slotW: widths[j], slotH: rowH };
      currentX += widths[j] + MIN_SPACING;
    });
    currentY += rowH + MIN_SPACING;
  });

  return placements;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function rectsOverlap(a, b) {
  return a.left < b.left + b.width  &&
         a.left + a.width  > b.left &&
         a.top  < b.top  + b.height &&
         a.top  + a.height > b.top;
}

// ─── Collage builders ────────────────────────────────────────────────────────
async function buildCollage(imagePaths) {
  try {
    return await buildClusterCollage(imagePaths);
  } catch (err) {
    log(`WARN: cluster layout failed (${err.message}) — falling back to grid`);
    return await buildGridCollage(imagePaths);
  }
}

async function buildClusterCollage(imagePaths) {
  const theme      = pickTheme();
  const count      = imagePaths.length;
  const candidates = CANDIDATE_GROUPS[count];
  const gridW      = CANVAS_SIZE - OUTER_PADDING * 2;
  const gridH      = CANVAS_SIZE - OUTER_PADDING * 2;

  // Get aspect ratios in parallel, then pick the best row grouping
  const aspectRatios = await Promise.all(imagePaths.map(getAspectRatio));
  const placements   = computeClusterLayout(aspectRatios, candidates, gridW, gridH);

  const composites = [];

  for (let i = 0; i < count; i++) {
    const { slotX, slotY, slotW, slotH } = placements[i];
    const sw = Math.max(1, Math.round(slotW));
    const sh = Math.max(1, Math.round(slotH));

    // Fit image inside its slot (no cropping, preserves AR)
    const fitted = await sharp(imagePaths[i])
      .rotate()
      .resize(sw, sh, { fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer();

    const { width: imgW, height: imgH } = await sharp(fitted).metadata();
    const rounded = await applyRoundedCorners(fitted, imgW, imgH, CORNER_RADIUS);

    // Center image inside its slot (handles any 0–1 px rounding diff)
    const left = Math.round(OUTER_PADDING + slotX + (slotW - imgW) / 2);
    const top  = Math.round(OUTER_PADDING + slotY + (slotH - imgH) / 2);

    composites.push({ input: rounded, left, top });
  }

  // Slot bounding boxes in canvas coordinates (used for overlap detection)
  const photoRects = placements.map(p => ({
    left:   Math.round(OUTER_PADDING + p.slotX),
    top:    Math.round(OUTER_PADDING + p.slotY),
    width:  Math.round(p.slotW),
    height: Math.round(p.slotH),
  }));

  // Pass 1 — render canvas without logo
  const canvasBuf = await sharp({ create: { width: CANVAS_SIZE, height: CANVAS_SIZE, channels: 4, background: theme.bg } })
    .png()
    .composite(composites)
    .toBuffer();

  // Pass 2 — build logo + conditional blur, write final file
  const logoComposites = await buildLogoComposites(canvasBuf, theme.logo, photoRects);
  const outPath = path.join(TEMP_DIR, `collage_${crypto.randomUUID()}.png`);
  await sharp(canvasBuf).composite(logoComposites).toFile(outPath);

  return outPath;
}

async function buildGridCollage(imagePaths) {
  const theme  = pickTheme();
  const count  = imagePaths.length;
  const [cols, rows] = GRID_LAYOUTS[count];
  const gridW  = CANVAS_SIZE - OUTER_PADDING * 2;
  const gridH  = CANVAS_SIZE - OUTER_PADDING * 2;
  const cellW  = Math.floor((gridW - MIN_SPACING * (cols - 1)) / cols);
  const cellH  = Math.floor((gridH - MIN_SPACING * (rows - 1)) / rows);
  const spacingX = cols > 1 ? (gridW - cols * cellW) / (cols - 1) : 0;
  const spacingY = rows > 1 ? (gridH - rows * cellH) / (rows - 1) : 0;
  const lastRowCount = count - (rows - 1) * cols;
  const composites   = [];
  const photoRects   = [];

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const isLastRow = row === rows - 1;

    let rowOffsetX = 0;
    if (isLastRow && lastRowCount < cols) {
      const usedW = lastRowCount * cellW + (lastRowCount - 1) * spacingX;
      rowOffsetX  = (gridW - usedW) / 2;
    }

    const cellLeft = OUTER_PADDING + rowOffsetX + col * (cellW + spacingX);
    const cellTop  = OUTER_PADDING + row * (cellH + spacingY);

    photoRects.push({
      left: Math.round(cellLeft), top: Math.round(cellTop),
      width: cellW, height: cellH,
    });

    const fitted = await sharp(imagePaths[i])
      .rotate()
      .resize(cellW, cellH, { fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer();

    const { width: imgW, height: imgH } = await sharp(fitted).metadata();
    const rounded = await applyRoundedCorners(fitted, imgW, imgH, CORNER_RADIUS);

    composites.push({
      input: rounded,
      left: Math.round(cellLeft + (cellW - imgW) / 2),
      top:  Math.round(cellTop  + (cellH - imgH) / 2),
    });
  }

  // Pass 1 — render canvas without logo
  const canvasBuf = await sharp({ create: { width: CANVAS_SIZE, height: CANVAS_SIZE, channels: 4, background: theme.bg } })
    .png()
    .composite(composites)
    .toBuffer();

  // Pass 2 — build logo + conditional blur, write final file
  const logoComposites = await buildLogoComposites(canvasBuf, theme.logo, photoRects);
  const outPath = path.join(TEMP_DIR, `collage_${crypto.randomUUID()}.png`);
  await sharp(canvasBuf).composite(logoComposites).toFile(outPath);

  return outPath;
}

// Build logo composites: logo on top, with optional soft blur when logo overlaps photos.
// canvasBuf is the already-rendered canvas (without logo).
// photoRects: array of {left, top, width, height} in canvas coordinates.
async function buildLogoComposites(canvasBuf, logoFile, photoRects = []) {
  const logoPath = path.join(__dirname, 'assets', logoFile);
  if (!fs.existsSync(logoPath)) {
    log(`WARN: assets/${logoFile} not found — skipping logo overlay`);
    return [];
  }

  const logoBuf = await sharp(fs.readFileSync(logoPath))
    .resize(LOGO_WIDTH, null, { fit: 'inside' })
    .png()
    .toBuffer();
  const { width: logoW, height: logoH } = await sharp(logoBuf).metadata();

  const logoLeft = LOGO_PADDING;
  const logoTop  = CANVAS_SIZE - LOGO_PADDING - logoH;

  // Blur zone: bottom 35% of logo (text area), slightly wider
  const coverH = Math.round(logoH * 0.35);
  const hPad   = 18;
  const vPad   = 8;

  const bdLeft   = Math.max(0, logoLeft - hPad);
  const bdTop    = Math.max(0, logoTop + logoH - coverH);
  const bdWidth  = Math.min(CANVAS_SIZE - bdLeft, logoW + hPad * 2);
  const bdHeight = Math.min(CANVAS_SIZE - bdTop,  coverH + vPad);

  log('Applying blur under logo (debug: radius 12)');

  // 1. Extract region and blur (12px for visual confirmation, reduce later)
  const blurred = await sharp(canvasBuf)
    .extract({ left: bdLeft, top: bdTop, width: bdWidth, height: bdHeight })
    .blur(12)
    .png()
    .toBuffer();

  // 2. Soft oval mask via radial gradient — fully feathered, no hard edges
  const svgMask = `<svg width="${bdWidth}" height="${bdHeight}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="g" cx="50%" cy="50%" rx="50%" ry="50%">
        <stop offset="0%"   stop-color="white" stop-opacity="1"/>
        <stop offset="60%"  stop-color="white" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${bdWidth}" height="${bdHeight}" fill="url(#g)"/>
  </svg>`;

  const mask = await sharp(Buffer.from(svgMask))
    .resize(bdWidth, bdHeight)
    .png()
    .toBuffer();

  // 3. Apply oval mask (dest-in)
  const backdrop = await sharp(blurred)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  return [
    { input: backdrop, left: bdLeft, top: bdTop },
    { input: logoBuf,  left: logoLeft, top: logoTop },
  ];
}

// ─── Photo processing ─────────────────────────────────────────────────────────
async function processPhotos(chatId, fileIds) {
  log(`Processing ${fileIds.length} image(s) for chat ${chatId}`);
  const downloadedPaths = [];
  let collagePath = null;

  try {
    for (let i = 0; i < fileIds.length; i++) {
      const file = await bot.telegram.getFile(fileIds[i]);
      const url  = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
      const dest = path.join(TEMP_DIR, `${chatId}_${i}_${Date.now()}.jpg`);
      await downloadFile(url, dest);
      downloadedPaths.push(dest);
      log(`Downloaded image ${i + 1}/${fileIds.length}`);
    }

    log('Building collage...');
    collagePath = await buildCollage(downloadedPaths);
    log(`Collage created: ${collagePath}`);

    await bot.telegram.sendPhoto(
      chatId,
      { source: fs.createReadStream(collagePath) },
      { caption: 'Готово! Вот твой коллаж 💙' }
    );
    log(`Collage sent to chat ${chatId}`);
  } catch (err) {
    log(`ERROR for chat ${chatId}: ${err.message}`);
    await bot.telegram.sendMessage(chatId, 'Ошибка при создании коллажа 👀');
  } finally {
    cleanFiles(downloadedPaths);
    if (collagePath) cleanFiles([collagePath]);
    log(`Temp files cleaned for chat ${chatId}`);
  }
}

// ─── Bot handlers ─────────────────────────────────────────────────────────────
bot.use((ctx, next) => {
  log(`Update received: ${ctx.updateType}`);
  return next();
});

bot.on(['photo', 'document'], async (ctx) => {
  try {
    // Resolve fileId — reject non-image documents
    let fileId;
    if (ctx.message.photo) {
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else {
      const doc = ctx.message.document;
      if (!doc.mime_type || !doc.mime_type.startsWith('image/')) {
        await ctx.reply('Можно отправить максимум 10 фото 👀');
        return;
      }
      fileId = doc.file_id;
    }

    const userId = ctx.from.id;
    const chatId = ctx.chat.id;

    // Initialize session synchronously — before any await
    if (!sessions[userId]) {
      sessions[userId] = { photos: [], timer: null, processingStarted: false };
    }
    const session = sessions[userId];

    if (session.photos.length < 10) {
      session.photos.push(fileId);
      log(`User ${userId} queued photo ${session.photos.length}/10`);
    } else {
      log(`User ${userId} hit 10-photo limit`);
    }

    // CRITICAL LOCK: set flag synchronously before await so concurrent
    // handlers arriving during the network call all see processingStarted=true
    if (session.processingStarted === false) {
      session.processingStarted = true;
      await ctx.reply('Собираю коллаж⏳');
    }

    clearTimeout(session.timer);
    session.timer = setTimeout(async () => {
      try {
        const photos = sessions[userId]?.photos ?? [];
        sessions[userId] = { photos: [], timer: null, processingStarted: false };
        await processPhotos(chatId, photos);
      } catch (e) {
        console.error('Session timer error:', e);
      }
    }, SESSION_TIMEOUT_MS);
  } catch (e) {
    console.error('handler error:', e);
  }
});

bot.start(async (ctx) => {
  try {
    await ctx.reply(
      'Привет! Отправь от 1 до 10 фотографий — я соберу коллаж ✨'
    );
  } catch (e) {
    console.error('start handler error:', e);
  }
});

bot.help(async (ctx) => {
  try {
    await ctx.reply(
      'Привет! Отправь от 1 до 10 фотографий — я соберу коллаж ✨'
    );
  } catch (e) {
    console.error('help handler error:', e);
  }
});

bot.catch((err, ctx) => {
  log(`Telegraf error for update ${ctx.updateType}: ${err.message}`);
});

// ─── HTTP server (for Render Web Service health checks) ──────────────────────
const express = require('express');
const app = express();
app.get('/', (_req, res) => res.send('Bot is running'));
app.listen(process.env.PORT || 3000);

// ─── Start ────────────────────────────────────────────────────────────────────
process.on('uncaughtException',  (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

log('Bot is running. Press Ctrl+C to stop.');
bot.launch({ dropPendingUpdates: true });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
