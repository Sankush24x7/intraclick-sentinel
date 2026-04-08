const sessions = new Map();
const panelPortsByTabId = new Map();
let panelState = {
  currentTabId: null
};

const WATERMARK_TEXT = chrome.runtime.getManifest().name || 'IntraClick Sentinel';

function getOrigin(url) {
  try {
    return new URL(String(url || '')).origin;
  } catch (_) {
    return '';
  }
}

function getRecordingOwnerTabId() {
  for (const [id, session] of sessions.entries()) {
    if (session.recording) return id;
  }
  return null;
}

function blankMetadata() {
  return {
    tester: '',
    module: '',
    ticketId: '',
    environment: '',
    buildVersion: ''
  };
}

function sanitizeMetadata(meta) {
  const next = blankMetadata();
  const src = meta || {};
  next.tester = String(src.tester || '').slice(0, 120);
  next.module = String(src.module || '').slice(0, 120);
  next.ticketId = String(src.ticketId || '').slice(0, 120);
  next.environment = String(src.environment || '').slice(0, 120);
  next.buildVersion = String(src.buildVersion || '').slice(0, 120);
  return next;
}

function getSession(tabId) {
  if (!sessions.has(tabId)) {
    sessions.set(tabId, {
      recording: false,
      paused: false,
      startedAt: null,
      stoppedAt: null,
      metadata: blankMetadata(),
      captures: [],
      queue: [],
      processing: false,
      lastCaptureTs: 0,
      linkedTabIds: new Set(),
      fullPageCapture: false
    });
  }
  return sessions.get(tabId);
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapePdfText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, ' ');
}

function truncateText(text, max = 180) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

async function notifyPanel(payload) {
  try {
    await chrome.runtime.sendMessage(payload);
  } catch (_) {
    // Side panel may not be open; ignore.
  }
}

async function ensureContentReady(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'clicksnap:ping' });
    return Boolean(ping?.ok);
  } catch (_) {
    // Inject content script for already-open tabs where declarative injection has not happened yet.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'clicksnap:ping' });
    return Boolean(ping?.ok);
  } catch (_) {
    return false;
  }
}

function buildDocHtml(report) {
  const metadataHtml = `
    <h3>Session Details</h3>
    <p><b>Tester:</b> ${escapeHtml(report.metadata?.tester || '-')}</p>
    <p><b>Module:</b> ${escapeHtml(report.metadata?.module || '-')}</p>
    <p><b>Ticket ID:</b> ${escapeHtml(report.metadata?.ticketId || '-')}</p>
    <p><b>Environment:</b> ${escapeHtml(report.metadata?.environment || '-')}</p>
    <p><b>Build Version:</b> ${escapeHtml(report.metadata?.buildVersion || '-')}</p>
    <hr/>
  `;

  const itemsHtml = report.captures.map((c, i) => {
    return `
      <section class="capture-step">
        <h3>Step ${i + 1}</h3>
        <p><b>Time:</b> ${escapeHtml(new Date(c.ts).toLocaleString())}</p>
        <p><b>Click Area:</b> ${escapeHtml(c.area || '-')}</p>
        <p><b>Tag:</b> ${escapeHtml(c.tag || '-')}</p>
        <p><b>URL:</b> ${escapeHtml(c.url)}</p>
        <p><b>Note:</b> ${escapeHtml(c.note || '-')}</p>
        <div class="capture-frame">
          <img class="capture-img" src="${c.imageDataUrl}" />
        </div>
      </section>
    `;
  }).join('\n');

  return `
    <html>
    <head>
      <meta charset="utf-8" />
      <title>ClickSnap Report</title>
      <style>
        @page { size: 11in 8.5in; margin: 0.5in; }
        body { font-family: Calibri, Arial, sans-serif; padding: 0; margin: 0; }
        h1 { color: #0f172a; }
        h3 { margin-bottom: 4px; }
        p { margin: 2px 0; }
        hr { margin: 14px 0; }
        .capture-step { page-break-inside: avoid; margin: 0 0 20px 0; }
        .capture-frame {
          width: 100%;
          min-height: 5.9in;
          border: 1px solid #ccc;
          padding: 8px;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .capture-img {
          display: block;
          width: 100%;
          max-height: 5.6in;
          height: auto;
          object-fit: contain;
        }
      </style>
    </head>
    <body>
      <h1>ClickSnap Evidence Report</h1>
      <p><b>Page:</b> ${escapeHtml(report.pageUrl)}</p>
      <p><b>Started:</b> ${escapeHtml(new Date(report.startedAt).toLocaleString())}</p>
      <p><b>Stopped:</b> ${escapeHtml(new Date(report.stoppedAt).toLocaleString())}</p>
      <p><b>Total Captures:</b> ${report.captures.length}</p>
      <hr/>
      ${metadataHtml}
      ${itemsHtml || '<p>No captures available.</p>'}
    </body>
    </html>
  `;
}

function buildReportForExport(session, message) {
  const fallbackCaptures = Array.isArray(message?.captures) ? message.captures : [];
  const capturesForExport = session.captures.length ? session.captures : fallbackCaptures;
  const fallbackMetadata = sanitizeMetadata(message?.metadata);
  const sessionMetadata = sanitizeMetadata(session.metadata);
  const metadataForExport = Object.values(sessionMetadata).some((v) => String(v || '').trim().length > 0)
    ? sessionMetadata
    : fallbackMetadata;
  const report = {
    pageUrl: message?.pageUrl || '',
    startedAt: session.startedAt || message?.startedAt || Date.now(),
    stoppedAt: session.stoppedAt || Date.now(),
    metadata: metadataForExport,
    captures: capturesForExport
  };
  return report;
}

function uint32ToLittleEndian(value) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ]);
}

function uint16ToLittleEndian(value) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff
  ]);
}

function dosDateTime(ts) {
  const date = new Date(ts || Date.now());
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const mins = date.getMinutes();
  const secs = Math.floor(date.getSeconds() / 2);
  const dosTime = (hours << 11) | (mins << 5) | secs;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dataUrlToBytes(dataUrl) {
  const raw = String(dataUrl || '');
  const commaIdx = raw.indexOf(',');
  if (commaIdx === -1) {
    throw new Error('Invalid image data URL.');
  }
  const b64 = raw.slice(commaIdx + 1);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildZipBlob(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralDirChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const fileBytes = entry.bytes;
    const csum = crc32(fileBytes);
    const { dosTime, dosDate } = dosDateTime(entry.ts);

    const localHeader = concatUint8Arrays([
      uint32ToLittleEndian(0x04034b50),
      uint16ToLittleEndian(20),
      uint16ToLittleEndian(0),
      uint16ToLittleEndian(0),
      uint16ToLittleEndian(dosTime),
      uint16ToLittleEndian(dosDate),
      uint32ToLittleEndian(csum),
      uint32ToLittleEndian(fileBytes.length),
      uint32ToLittleEndian(fileBytes.length),
      uint16ToLittleEndian(nameBytes.length),
      uint16ToLittleEndian(0),
      nameBytes,
      fileBytes
    ]);
    chunks.push(localHeader);

    const centralHeader = concatUint8Arrays([
      uint32ToLittleEndian(0x02014b50),
      uint16ToLittleEndian(20),
      uint16ToLittleEndian(20),
      uint16ToLittleEndian(0),
      uint16ToLittleEndian(0),
      uint16ToLittleEndian(dosTime),
      uint16ToLittleEndian(dosDate),
      uint32ToLittleEndian(csum),
      uint32ToLittleEndian(fileBytes.length),
      uint32ToLittleEndian(fileBytes.length),
      uint16ToLittleEndian(nameBytes.length),
      uint16ToLittleEndian(0),
      uint16ToLittleEndian(0),
      uint16ToLittleEndian(0),
      uint16ToLittleEndian(0),
      uint32ToLittleEndian(0),
      uint32ToLittleEndian(offset),
      nameBytes
    ]);
    centralDirChunks.push(centralHeader);
    offset += localHeader.length;
  }

  const centralDir = concatUint8Arrays(centralDirChunks);
  const eocd = concatUint8Arrays([
    uint32ToLittleEndian(0x06054b50),
    uint16ToLittleEndian(0),
    uint16ToLittleEndian(0),
    uint16ToLittleEndian(entries.length),
    uint16ToLittleEndian(entries.length),
    uint32ToLittleEndian(centralDir.length),
    uint32ToLittleEndian(offset),
    uint16ToLittleEndian(0)
  ]);

  return new Blob([concatUint8Arrays([...chunks, centralDir, eocd])], { type: 'application/zip' });
}

async function blobToBytes(blob) {
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

async function buildZipExportBlob(report) {
  const encoder = new TextEncoder();
  const timestamp = Date.now();
  const safeStamp = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
  const root = `clicksnap-report-${safeStamp}`;

  const docHtml = buildDocHtml(report);
  const docBytes = encoder.encode(docHtml);
  const pdfBlob = await buildPdfBlob(report);
  const pdfBytes = await blobToBytes(pdfBlob);

  const screenshotEntries = [];
  const captureLog = [];
  report.captures.forEach((capture, idx) => {
    const step = String(idx + 1).padStart(3, '0');
    const filename = `screenshots/step-${step}.png`;
    screenshotEntries.push({
      name: `${root}/${filename}`,
      bytes: dataUrlToBytes(capture.imageDataUrl),
      ts: capture.ts
    });
    captureLog.push({
      step: idx + 1,
      id: capture.id,
      ts: capture.ts,
      time: new Date(capture.ts).toLocaleString(),
      url: capture.url || '',
      area: capture.area || '-',
      tag: capture.tag || '-',
      note: capture.note || '-',
      file: filename
    });
  });

  const reportJson = {
    generatedAt: timestamp,
    generatedAtIso: new Date(timestamp).toISOString(),
    pageUrl: report.pageUrl || '',
    startedAt: report.startedAt || timestamp,
    stoppedAt: report.stoppedAt || timestamp,
    metadata: report.metadata || {},
    totalCaptures: report.captures.length,
    captures: captureLog
  };

  const zipEntries = [
    {
      name: `${root}/report.doc`,
      bytes: docBytes,
      ts: timestamp
    },
    {
      name: `${root}/report.pdf`,
      bytes: pdfBytes,
      ts: timestamp
    },
    {
      name: `${root}/captures.json`,
      bytes: encoder.encode(JSON.stringify(reportJson, null, 2)),
      ts: timestamp
    },
    ...screenshotEntries
  ];

  return buildZipBlob(zipEntries);
}

function concatUint8Arrays(arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    output.set(arr, offset);
    offset += arr.length;
  }
  return output;
}

async function dataUrlToJpegImageData(dataUrl, quality = 0.9) {
  const srcBlob = await fetch(dataUrl).then((r) => r.blob());
  const bitmap = await createImageBitmap(srcBlob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to prepare screenshot image for PDF.');
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const jpegBuffer = await jpegBlob.arrayBuffer();
  return {
    width: bitmap.width,
    height: bitmap.height,
    bytes: new Uint8Array(jpegBuffer)
  };
}

function makePdfStreamObjectBody(streamBytes, dictionaryLines) {
  const encoder = new TextEncoder();
  const header = encoder.encode(
    `<<\n${dictionaryLines.join('\n')}\n/Length ${streamBytes.length}\n>>\nstream\n`
  );
  const footer = encoder.encode('\nendstream');
  return concatUint8Arrays([header, streamBytes, footer]);
}

async function buildPdfBlob(report) {
  const encoder = new TextEncoder();
  const captures = Array.isArray(report.captures) ? report.captures : [];
  if (!captures.length) {
    throw new Error('No screenshots captured yet.');
  }

  const pageWidth = 842;
  const pageHeight = 595;
  const margin = 28;
  const headerTop = 34;
  const metaLineGap = 14;
  const imageTop = 128;
  const imageBottom = 28;
  const imageAreaWidth = pageWidth - (margin * 2);
  const imageAreaHeight = pageHeight - imageTop - imageBottom;

  const prepared = [];
  for (const capture of captures) {
    prepared.push({
      capture,
      image: await dataUrlToJpegImageData(capture.imageDataUrl)
    });
  }

  let objId = 3;
  const objectPlan = prepared.map(() => {
    const pageObjId = ++objId;
    const contentObjId = ++objId;
    const imageObjId = ++objId;
    return { pageObjId, contentObjId, imageObjId };
  });
  const maxObjId = objId;

  const parts = [encoder.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  const offsets = new Array(maxObjId + 1).fill(0);
  let currentOffset = parts[0].length;

  const appendBytes = (bytes) => {
    parts.push(bytes);
    currentOffset += bytes.length;
  };

  const appendObject = (id, body) => {
    offsets[id] = currentOffset;
    appendBytes(encoder.encode(`${id} 0 obj\n`));
    appendBytes(body);
    appendBytes(encoder.encode('\nendobj\n'));
  };

  const pageRefs = objectPlan.map((plan) => `${plan.pageObjId} 0 R`).join(' ');
  appendObject(1, encoder.encode('<< /Type /Catalog /Pages 2 0 R >>'));
  appendObject(2, encoder.encode(`<< /Type /Pages /Kids [ ${pageRefs} ] /Count ${prepared.length} >>`));
  appendObject(3, encoder.encode('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));

  prepared.forEach((item, index) => {
    const { capture, image } = item;
    const { pageObjId, contentObjId, imageObjId } = objectPlan[index];
    const imageName = `Im${index + 1}`;
    const scale = Math.min(imageAreaWidth / image.width, imageAreaHeight / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    const drawX = (pageWidth - drawWidth) / 2;
    const drawY = imageBottom + ((imageAreaHeight - drawHeight) / 2);
    const timeText = new Date(capture.ts).toLocaleString();
    const stepTitle = `ClickSnap Evidence Report - Step ${index + 1} of ${prepared.length}`;

    const contentText = [
      'BT',
      '/F1 16 Tf',
      `${margin} ${pageHeight - headerTop} Td`,
      `(${escapePdfText(stepTitle)}) Tj`,
      'ET',
      'BT',
      '/F1 10 Tf',
      `${margin} ${pageHeight - (headerTop + metaLineGap + 8)} Td`,
      `(${escapePdfText(`Time: ${timeText}`)}) Tj`,
      'ET',
      'BT',
      '/F1 10 Tf',
      `${margin} ${pageHeight - (headerTop + (metaLineGap * 2) + 8)} Td`,
      `(${escapePdfText(`Area: ${truncateText(capture.area || '-')}`)}) Tj`,
      'ET',
      'BT',
      '/F1 10 Tf',
      `${margin} ${pageHeight - (headerTop + (metaLineGap * 3) + 8)} Td`,
      `(${escapePdfText(`Tag: ${truncateText(capture.tag || '-')}`)}) Tj`,
      'ET',
      'BT',
      '/F1 10 Tf',
      `${margin} ${pageHeight - (headerTop + (metaLineGap * 4) + 8)} Td`,
      `(${escapePdfText(`URL: ${truncateText(capture.url || '-')}`)}) Tj`,
      'ET',
      'BT',
      '/F1 10 Tf',
      `${margin} ${pageHeight - (headerTop + (metaLineGap * 5) + 8)} Td`,
      `(${escapePdfText(`Note: ${truncateText(capture.note || '-')}`)}) Tj`,
      'ET',
      'q',
      `${drawWidth.toFixed(3)} 0 0 ${drawHeight.toFixed(3)} ${drawX.toFixed(3)} ${drawY.toFixed(3)} cm`,
      `/${imageName} Do`,
      'Q'
    ].join('\n');

    const contentBytes = encoder.encode(contentText);
    const contentBody = makePdfStreamObjectBody(contentBytes, []);
    appendObject(contentObjId, contentBody);

    const imageBody = makePdfStreamObjectBody(
      image.bytes,
      [
        '/Type /XObject',
        '/Subtype /Image',
        `/Width ${image.width}`,
        `/Height ${image.height}`,
        '/ColorSpace /DeviceRGB',
        '/BitsPerComponent 8',
        '/Filter /DCTDecode'
      ]
    );
    appendObject(imageObjId, imageBody);

    const pageBody = encoder.encode(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R >> /XObject << /${imageName} ${imageObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>`
    );
    appendObject(pageObjId, pageBody);
  });

  const xrefStart = currentOffset;
  const xrefLines = ['xref', `0 ${maxObjId + 1}`, '0000000000 65535 f '];
  for (let i = 1; i <= maxObjId; i += 1) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n `);
  }
  appendBytes(encoder.encode(`${xrefLines.join('\n')}\n`));
  appendBytes(
    encoder.encode(
      `trailer\n<< /Size ${maxObjId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
    )
  );

  return new Blob([concatUint8Arrays(parts)], { type: 'application/pdf' });
}

async function captureClick(tabId, payload) {
  const ownerTabId = getRecordingOwnerTabId();
  if (ownerTabId === null) return;

  const session = getSession(ownerTabId);
  if (!session.recording || session.paused) return;

  if (!(await canLinkTabToSession(ownerTabId, tabId, session))) {
    return;
  }

  session.queue.push({ sourceTabId: tabId, payload });
  processCaptureQueue(ownerTabId);
}

async function canLinkTabToSession(ownerTabId, candidateTabId, session) {
  if (candidateTabId === ownerTabId) return true;
  if (session.linkedTabIds?.has(candidateTabId)) return true;

  try {
    const [ownerTab, candidateTab] = await Promise.all([
      chrome.tabs.get(ownerTabId),
      chrome.tabs.get(candidateTabId)
    ]);

    const openerId = candidateTab?.openerTabId;
    const linkedByOpener =
      openerId === ownerTabId || (typeof openerId === 'number' && session.linkedTabIds?.has(openerId));
    if (linkedByOpener) {
      session.linkedTabIds.add(candidateTabId);
      return true;
    }

    const ownerOrigin = getOrigin(ownerTab?.url);
    const candidateOrigin = getOrigin(candidateTab?.url);
    if (ownerOrigin && candidateOrigin && ownerOrigin === candidateOrigin) {
      session.linkedTabIds.add(candidateTabId);
      return true;
    }
  } catch (_) {
    return false;
  }

  return false;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function processImage(dataUrl, processor) {
  const srcBlob = await fetch(dataUrl).then((r) => r.blob());
  const bitmap = await createImageBitmap(srcBlob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;

  ctx.drawImage(bitmap, 0, 0);
  processor(ctx, bitmap.width, bitmap.height);

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const outDataUrl = await blobToDataUrl(outBlob);
  return typeof outDataUrl === 'string' ? outDataUrl : dataUrl;
}

function normalizeSensitiveRects(rects, width, height) {
  if (!Array.isArray(rects)) return [];
  return rects
    .map((r) => {
      const x = Math.max(0, Math.floor(Number(r?.x) || 0));
      const y = Math.max(0, Math.floor(Number(r?.y) || 0));
      const w = Math.max(0, Math.floor(Number(r?.width) || 0));
      const h = Math.max(0, Math.floor(Number(r?.height) || 0));
      return {
        x: Math.min(x, width),
        y: Math.min(y, height),
        width: Math.min(w, Math.max(0, width - x)),
        height: Math.min(h, Math.max(0, height - y))
      };
    })
    .filter((r) => r.width > 0 && r.height > 0);
}

async function applySensitiveRedaction(dataUrl, rects) {
  try {
    return await processImage(dataUrl, (ctx, width, height) => {
      const safeRects = normalizeSensitiveRects(rects, width, height);
      if (!safeRects.length) return;

      for (const rect of safeRects) {
        ctx.fillStyle = 'rgba(2, 6, 23, 0.78)';
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
    });
  } catch (_) {
    return dataUrl;
  }
}

async function addWatermarkToImage(dataUrl, text) {
  try {
    return await processImage(dataUrl, (ctx, width, height) => {
      const diagonal = Math.sqrt((width * width) + (height * height));
      const fontSize = Math.max(26, Math.round(diagonal * 0.06));
      const textValue = String(text || '').trim() || WATERMARK_TEXT;

      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate((-45 * Math.PI) / 180);
      ctx.font = `700 ${fontSize}px "Segoe UI", Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(71, 85, 105, 0.16)';

      const textWidth = Math.max(1, Math.ceil(ctx.measureText(textValue).width));
      const stepX = Math.max(textWidth + Math.round(fontSize * 1.4), Math.round(diagonal * 0.55));
      const stepY = Math.max(Math.round(fontSize * 2.2), 96);
      const half = Math.ceil(diagonal);

      for (let y = -half; y <= half; y += stepY) {
        for (let x = -half; x <= half; x += stepX) {
          ctx.fillText(textValue, x, y);
        }
      }
      ctx.restore();
    });
  } catch (_) {
    return dataUrl;
  }
}

async function captureWithRetry(windowId, retries = 2) {
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      const msg = String(e?.message || e || '').toLowerCase();
      const rateLimited = msg.includes('max_capture_visible_tab_calls_per_second');
      const readbackFailed = msg.includes('image readback failed');
      const temporaryCaptureIssue =
        msg.includes('failed to capture tab') ||
        msg.includes('cannot capture') ||
        msg.includes('unable to capture');

      const canRetry = rateLimited || readbackFailed || temporaryCaptureIssue;
      if (!canRetry || i === retries) throw e;

      const backoffMs = rateLimited ? 600 : (220 * (i + 1));
      await wait(backoffMs);
    }
  }
  return null;
}

async function runScriptOnTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return results?.[0]?.result;
}

function buildScrollSteps(total, viewport) {
  if (!Number.isFinite(total) || !Number.isFinite(viewport) || total <= 0 || viewport <= 0) return [0];
  if (total <= viewport) return [0];
  const max = total - viewport;
  const steps = [];
  for (let pos = 0; pos <= max; pos += viewport) {
    steps.push(Math.round(pos));
  }
  if (steps[steps.length - 1] !== Math.round(max)) {
    steps.push(Math.round(max));
  }
  return steps;
}

async function getPageCaptureMetrics(tabId) {
  return runScriptOnTab(
    tabId,
    () => {
      const doc = document.documentElement;
      const body = document.body;
      const scrollWidth = Math.max(
        doc?.scrollWidth || 0,
        body?.scrollWidth || 0,
        doc?.clientWidth || 0,
        window.innerWidth || 0
      );
      const scrollHeight = Math.max(
        doc?.scrollHeight || 0,
        body?.scrollHeight || 0,
        doc?.clientHeight || 0,
        window.innerHeight || 0
      );
      return {
        scrollWidth,
        scrollHeight,
        viewportWidth: window.innerWidth || doc?.clientWidth || 0,
        viewportHeight: window.innerHeight || doc?.clientHeight || 0,
        dpr: window.devicePixelRatio || 1,
        scrollX: window.scrollX || window.pageXOffset || 0,
        scrollY: window.scrollY || window.pageYOffset || 0
      };
    }
  );
}

async function scrollToPosition(tabId, x, y) {
  return runScriptOnTab(
    tabId,
    (nx, ny) => {
      window.scrollTo(nx, ny);
      return {
        x: window.scrollX || window.pageXOffset || 0,
        y: window.scrollY || window.pageYOffset || 0
      };
    },
    [x, y]
  );
}

async function captureFullPageWithStitch(tabId, windowId) {
  const metrics = await getPageCaptureMetrics(tabId);
  if (!metrics || !metrics.viewportWidth || !metrics.viewportHeight) {
    throw new Error('Unable to read page dimensions for full-page capture.');
  }

  const dpr = Math.max(1, Number(metrics.dpr) || 1);
  const totalWidthPx = Math.max(1, Math.round(metrics.scrollWidth * dpr));
  const totalHeightPx = Math.max(1, Math.round(metrics.scrollHeight * dpr));
  const MAX_DIMENSION = 16384;
  if (totalWidthPx > MAX_DIMENSION || totalHeightPx > MAX_DIMENSION) {
    throw new Error('Page too large for full-page capture. Try visible mode.');
  }

  const canvas = new OffscreenCanvas(totalWidthPx, totalHeightPx);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to create full-page capture canvas.');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalWidthPx, totalHeightPx);

  const xSteps = buildScrollSteps(metrics.scrollWidth, metrics.viewportWidth);
  const ySteps = buildScrollSteps(metrics.scrollHeight, metrics.viewportHeight);
  const originalX = Math.max(0, Math.round(metrics.scrollX || 0));
  const originalY = Math.max(0, Math.round(metrics.scrollY || 0));

  try {
    for (const y of ySteps) {
      for (const x of xSteps) {
        const current = await scrollToPosition(tabId, x, y);
        await wait(130);
        const tileUrl = await captureWithRetry(windowId, 4);
        const tileBlob = await fetch(tileUrl).then((r) => r.blob());
        const tileBitmap = await createImageBitmap(tileBlob);
        const dx = Math.max(0, Math.round((current?.x || x) * dpr));
        const dy = Math.max(0, Math.round((current?.y || y) * dpr));
        const drawW = Math.min(tileBitmap.width, totalWidthPx - dx);
        const drawH = Math.min(tileBitmap.height, totalHeightPx - dy);
        if (drawW > 0 && drawH > 0) {
          ctx.drawImage(tileBitmap, 0, 0, drawW, drawH, dx, dy, drawW, drawH);
        }
      }
    }
  } finally {
    await scrollToPosition(tabId, originalX, originalY).catch(() => {});
  }

  const mergedBlob = await canvas.convertToBlob({ type: 'image/png' });
  const mergedDataUrl = await blobToDataUrl(mergedBlob);
  if (typeof mergedDataUrl !== 'string') {
    throw new Error('Failed to build full-page screenshot.');
  }
  return mergedDataUrl;
}

async function processCaptureQueue(ownerTabId) {
  const session = getSession(ownerTabId);
  if (session.processing) return;
  session.processing = true;

  while (session.recording && !session.paused && session.queue.length > 0) {
    const queued = session.queue.shift();
    const sourceTabId = queued?.sourceTabId;
    const payload = queued?.payload || {};

    let dataUrl;
    try {
      const tab = await chrome.tabs.get(sourceTabId);
      const now = Date.now();
      const gap = now - session.lastCaptureTs;
      if (gap < 550) {
        await wait(550 - gap);
      }

      if (session.fullPageCapture) {
        dataUrl = await captureFullPageWithStitch(sourceTabId, tab.windowId);
      } else {
        dataUrl = await captureWithRetry(tab.windowId, 4);
      }
      dataUrl = await applySensitiveRedaction(dataUrl, payload.sensitiveRects || []);
      dataUrl = await addWatermarkToImage(dataUrl, WATERMARK_TEXT);
      session.lastCaptureTs = Date.now();
    } catch (e) {
      await notifyPanel({
        type: 'panel:error',
        message: `Screenshot failed: ${String(e?.message || e)}`
      });
      continue;
    }

    const capture = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      url: payload.url || '',
      area: payload.area || '-',
      tag: payload.tag || '-',
      note: '',
      imageDataUrl: dataUrl
    };

    session.captures.push(capture);

    await notifyPanel({
      type: 'panel:newCapture',
      capture,
      tabId: ownerTabId,
      count: session.captures.length
    });
  }

  session.processing = false;
}

async function sendStartToTab(tabId) {
  const ready = await ensureContentReady(tabId);
  if (!ready) return false;
  await chrome.tabs.sendMessage(tabId, { type: 'clicksnap:start' }).catch(() => {});
  return true;
}

async function stopInTab(tabId) {
  if (typeof tabId !== 'number') return;
  await chrome.tabs.sendMessage(tabId, { type: 'clicksnap:stop' }).catch(() => {});
}

async function stopSessionRecording(tabId) {
  if (typeof tabId !== 'number') return;
  const session = getSession(tabId);
  if (!session.recording) return;

  const linkedIds = Array.from(session.linkedTabIds || []);
  session.recording = false;
  session.paused = false;
  session.stoppedAt = Date.now();
  session.queue = [];
  session.processing = false;
  session.linkedTabIds = new Set();

  await Promise.all(linkedIds.map((id) => stopInTab(id)));
  await stopInTab(tabId);
}

async function openSidePanelForTab(tabId) {
  try {
    await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    await chrome.sidePanel.open({ tabId });
    panelState.currentTabId = tabId;
  } catch (_) {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  await openSidePanelForTab(tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id ?? message?.tabId ?? panelState.currentTabId;

  if (message?.type === 'panel:getState') {
    const id = message.tabId;
    const session = getSession(id);
    sendResponse({
      ok: true,
      tabId: id,
      recording: session.recording,
      paused: session.paused,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      metadata: session.metadata,
      captures: session.captures,
      fullPageCapture: Boolean(session.fullPageCapture)
    });
    return true;
  }

  if (message?.type === 'panel:updateMetadata' && typeof tabId === 'number') {
    const session = getSession(tabId);
    session.metadata = sanitizeMetadata(message.metadata);
    sendResponse({ ok: true, metadata: session.metadata });
    return true;
  }

  if (message?.type === 'panel:updateCaptureNote' && typeof tabId === 'number') {
    const session = getSession(tabId);
    const id = String(message.captureId || '');
    const note = String(message.note || '').slice(0, 500);
    const target = session.captures.find((c) => c.id === id);
    if (!target) {
      sendResponse({ ok: false, error: 'Capture not found.' });
      return true;
    }
    target.note = note;
    sendResponse({ ok: true, captures: session.captures });
    return true;
  }

  if (message?.type === 'panel:setCaptureMode' && typeof tabId === 'number') {
    const session = getSession(tabId);
    session.fullPageCapture = Boolean(message.fullPageCapture);
    sendResponse({ ok: true, fullPageCapture: session.fullPageCapture });
    return true;
  }

  if (message?.type === 'panel:start' && typeof tabId === 'number') {
    (async () => {
      const ready = await ensureContentReady(tabId);
      if (!ready) {
        sendResponse({
          ok: false,
          error: 'Cannot attach recorder on this page. Open a normal website tab and try again.'
        });
        return;
      }

      const previousOwner = getRecordingOwnerTabId();
      if (typeof previousOwner === 'number' && previousOwner !== tabId) {
        await stopSessionRecording(previousOwner);
      }

      const session = getSession(tabId);
      session.recording = true;
      session.paused = false;
      session.startedAt = Date.now();
      session.stoppedAt = null;
      session.captures = [];
      session.queue = [];
      session.processing = false;
      session.lastCaptureTs = 0;
      session.linkedTabIds = new Set([tabId]);
      session.fullPageCapture = Boolean(message.fullPageCapture);

      await sendStartToTab(tabId);
      sendResponse({
        ok: true,
        startedAt: session.startedAt,
        fullPageCapture: session.fullPageCapture
      });
    })();
    return true;
  }

  if (message?.type === 'panel:pause' && typeof tabId === 'number') {
    const session = getSession(tabId);
    if (!session.recording) {
      sendResponse({ ok: false, error: 'Session is not running.' });
      return true;
    }
    session.paused = true;
    sendResponse({ ok: true, paused: true });
    return true;
  }

  if (message?.type === 'panel:resume' && typeof tabId === 'number') {
    const session = getSession(tabId);
    if (!session.recording) {
      sendResponse({ ok: false, error: 'Session is not running.' });
      return true;
    }
    session.paused = false;
    processCaptureQueue(tabId).catch(() => {});
    sendResponse({ ok: true, paused: false });
    return true;
  }

  if (message?.type === 'panel:stop' && typeof tabId === 'number') {
    stopSessionRecording(tabId).catch(() => {});
    const session = getSession(tabId);
    sendResponse({ ok: true, stoppedAt: session.stoppedAt || Date.now(), count: session.captures.length });
    return true;
  }

  if (message?.type === 'content:click' && typeof tabId === 'number') {
    captureClick(tabId, message.payload || {});
    return false;
  }

  if (message?.type === 'panel:exportWord' && typeof tabId === 'number') {
    const session = getSession(tabId);
    const report = buildReportForExport(session, message);
    if (!report.captures.length) {
      sendResponse({ ok: false, error: 'No screenshots captured yet.' });
      return true;
    }

    const html = buildDocHtml(report);
    const blob = new Blob([html], { type: 'application/msword' });
    const reader = new FileReader();

    reader.onloadend = async () => {
      await chrome.downloads.download({
        url: reader.result,
        filename: `clicksnap-report-${Date.now()}.doc`,
        saveAs: true
      });
      sendResponse({ ok: true });
    };

    reader.readAsDataURL(blob);
    return true;
  }

  if (message?.type === 'panel:exportPdf' && typeof tabId === 'number') {
    const session = getSession(tabId);
    const report = buildReportForExport(session, message);
    if (!report.captures.length) {
      sendResponse({ ok: false, error: 'No screenshots captured yet.' });
      return true;
    }

    (async () => {
      try {
        const pdfBlob = await buildPdfBlob(report);
        const reader = new FileReader();
        reader.onloadend = async () => {
          await chrome.downloads.download({
            url: reader.result,
            filename: `clicksnap-report-${Date.now()}.pdf`,
            saveAs: true
          });
          sendResponse({ ok: true });
        };
        reader.readAsDataURL(pdfBlob);
      } catch (e) {
        sendResponse({ ok: false, error: `PDF export failed: ${String(e?.message || e)}` });
      }
    })();

    return true;
  }

  if (message?.type === 'panel:exportZip' && typeof tabId === 'number') {
    const session = getSession(tabId);
    const report = buildReportForExport(session, message);
    if (!report.captures.length) {
      sendResponse({ ok: false, error: 'No screenshots captured yet.' });
      return true;
    }

    (async () => {
      try {
        const zipBlob = await buildZipExportBlob(report);
        const reader = new FileReader();
        reader.onloadend = async () => {
          await chrome.downloads.download({
            url: reader.result,
            filename: `clicksnap-report-${Date.now()}.zip`,
            saveAs: true
          });
          sendResponse({ ok: true });
        };
        reader.readAsDataURL(zipBlob);
      } catch (e) {
        sendResponse({ ok: false, error: `ZIP export failed: ${String(e?.message || e)}` });
      }
    })();

    return true;
  }

  if (message?.type === 'panel:deleteCapture' && typeof tabId === 'number') {
    const session = getSession(tabId);
    const id = String(message.captureId || '');
    const before = session.captures.length;
    session.captures = session.captures.filter((c) => c.id !== id);
    sendResponse({ ok: true, removed: before - session.captures.length, captures: session.captures });
    return true;
  }

  if (message?.type === 'panel:clearCaptures' && typeof tabId === 'number') {
    const session = getSession(tabId);
    session.captures = [];
    session.queue = [];
    sendResponse({ ok: true, captures: [] });
    return true;
  }

  if (message?.type === 'panel:close' && typeof tabId === 'number') {
    stopSessionRecording(tabId).catch(() => {});
    chrome.sidePanel.setOptions({ tabId, enabled: false }).finally(() => {
      // Re-enable so user can open it again by clicking action.
      chrome.sidePanel.setOptions({ tabId, enabled: true, path: 'sidepanel.html' }).catch(() => {});
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'panel:setTab' && typeof message.tabId === 'number') {
    panelState.currentTabId = message.tabId;
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'clicksnap:panel') return;
  let boundTabId = null;

  port.onMessage.addListener((message) => {
    if (message?.type === 'panel:bind' && typeof message.tabId === 'number') {
      boundTabId = message.tabId;
      panelPortsByTabId.set(boundTabId, port);
    }
  });

  port.onDisconnect.addListener(() => {
    if (typeof boundTabId !== 'number') return;
    const activePort = panelPortsByTabId.get(boundTabId);
    if (activePort === port) {
      panelPortsByTabId.delete(boundTabId);
    }
    stopSessionRecording(boundTabId).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  panelPortsByTabId.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const ownerTabId = getRecordingOwnerTabId();
  if (ownerTabId === null) return;

  const session = getSession(ownerTabId);
  if (!session.recording) return;

  canLinkTabToSession(ownerTabId, tabId, session)
    .then((ok) => {
      if (!ok) return;
      session.linkedTabIds.add(tabId);
      sendStartToTab(tabId).catch(() => {});
    })
    .catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab?.id) return;
  const ownerTabId = getRecordingOwnerTabId();
  if (ownerTabId === null) return;

  const session = getSession(ownerTabId);
  if (!session.recording) return;

  const openerId = tab.openerTabId;
  const isLinked =
    openerId === ownerTabId || (typeof openerId === 'number' && session.linkedTabIds.has(openerId));
  if (!isLinked) {
    chrome.tabs.get(ownerTabId).then((ownerTab) => {
      const ownerOrigin = getOrigin(ownerTab?.url);
      const newTabOrigin = getOrigin(tab.url || tab.pendingUrl);
      if (!(ownerOrigin && newTabOrigin && ownerOrigin === newTabOrigin)) return;
      session.linkedTabIds.add(tab.id);
    }).catch(() => {});
    return;
  }

  session.linkedTabIds.add(tab.id);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  const activeTabId = activeInfo?.tabId;
  if (typeof activeTabId !== 'number') return;

  const ownerTabId = getRecordingOwnerTabId();
  if (ownerTabId === null) return;

  const session = getSession(ownerTabId);
  if (!session.recording) return;

  canLinkTabToSession(ownerTabId, activeTabId, session)
    .then((ok) => {
      if (!ok) return;
      session.linkedTabIds.add(activeTabId);
      sendStartToTab(activeTabId).catch(() => {});
    })
    .catch(() => {});
});
