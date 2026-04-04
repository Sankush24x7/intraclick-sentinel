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
      linkedTabIds: new Set()
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
      <h3>Step ${i + 1}</h3>
      <p><b>Time:</b> ${escapeHtml(new Date(c.ts).toLocaleString())}</p>
      <p><b>Click Area:</b> ${escapeHtml(c.area || '-')}</p>
      <p><b>Tag:</b> ${escapeHtml(c.tag || '-')}</p>
      <p><b>URL:</b> ${escapeHtml(c.url)}</p>
      <p><b>Note:</b> ${escapeHtml(c.note || '-')}</p>
      <img src="${c.imageDataUrl}" style="max-width:100%;border:1px solid #ccc;" />
      <hr/>
    `;
  }).join('\n');

  return `
    <html>
    <head>
      <meta charset="utf-8" />
      <title>ClickSnap Report</title>
      <style>
        body { font-family: Calibri, Arial, sans-serif; padding: 20px; }
        h1 { color: #0f172a; }
        h3 { margin-bottom: 4px; }
        p { margin: 2px 0; }
        hr { margin: 14px 0; }
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

      dataUrl = await captureWithRetry(tab.windowId, 4);
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
      captures: session.captures
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

      await sendStartToTab(tabId);
      sendResponse({ ok: true, startedAt: session.startedAt });
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
    const fallbackCaptures = Array.isArray(message.captures) ? message.captures : [];
    const capturesForExport = session.captures.length ? session.captures : fallbackCaptures;
    const fallbackMetadata = sanitizeMetadata(message.metadata);
    const sessionMetadata = sanitizeMetadata(session.metadata);
    const metadataForExport = Object.values(sessionMetadata).some((v) => String(v || '').trim().length > 0)
      ? sessionMetadata
      : fallbackMetadata;

    if (!capturesForExport.length) {
      sendResponse({ ok: false, error: 'No screenshots captured yet.' });
      return true;
    }

    const report = {
      pageUrl: message.pageUrl || '',
      startedAt: session.startedAt || message.startedAt || Date.now(),
      stoppedAt: session.stoppedAt || Date.now(),
      metadata: metadataForExport,
      captures: capturesForExport
    };

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
