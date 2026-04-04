const ui = {
  start: document.getElementById('startBtn'),
  pause: document.getElementById('pauseBtn'),
  stop: document.getElementById('stopBtn'),
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
  closeBtn: document.getElementById('closeBtn'),
  previousBtn: document.getElementById('previousBtn'),
  toggleSessionBtn: document.getElementById('toggleSessionBtn'),
  sessionMetaBody: document.getElementById('sessionMetaBody'),
  testerInput: document.getElementById('testerInput'),
  moduleInput: document.getElementById('moduleInput'),
  ticketInput: document.getElementById('ticketInput'),
  envInput: document.getElementById('envInput'),
  buildInput: document.getElementById('buildInput'),
  statusText: document.getElementById('statusText'),
  countText: document.getElementById('countText'),
  timerText: document.getElementById('timerText'),
  gallery: document.getElementById('gallery'),
  errorBox: document.getElementById('errorBox'),
  historyModal: document.getElementById('historyModal'),
  historyGrid: document.getElementById('historyGrid'),
  modalCloseBtn: document.getElementById('modalCloseBtn')
};

const state = {
  tabId: null,
  recording: false,
  paused: false,
  startedAt: null,
  captures: [],
  metadata: {
    tester: '',
    module: '',
    ticketId: '',
    environment: '',
    buildVersion: ''
  },
  allowClose: false,
  sessionExpanded: false,
  modalOpen: false
};

let panelPort = null;
let metadataSaveTimer = null;
let countdownTimer = null;
const EXPORT_TIME_LIMIT_MS = 10 * 60 * 1000;

function showError(msg) {
  if (!msg) {
    ui.errorBox.classList.add('hidden');
    ui.errorBox.textContent = '';
    return;
  }
  ui.errorBox.classList.remove('hidden');
  ui.errorBox.textContent = msg;
}

function renderControls() {
  ui.start.disabled = state.recording;
  ui.pause.disabled = !state.recording;
  ui.stop.disabled = !state.recording;
  ui.exportBtn.disabled = state.captures.length === 0;
  ui.clearBtn.disabled = state.captures.length === 0;
  ui.previousBtn.disabled = state.captures.length === 0;

  if (state.recording && state.paused) {
    ui.statusText.textContent = 'Paused';
    ui.pause.textContent = 'Resume';
  } else if (state.recording) {
    ui.statusText.textContent = 'Recording clicks...';
    ui.pause.textContent = 'Pause';
  } else {
    ui.statusText.textContent = 'Idle';
    ui.pause.textContent = 'Pause';
  }

  ui.countText.textContent = `${state.captures.length} screenshots`;
  renderTimer();
}

function formatTimeMs(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const min = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function renderTimer() {
  const hasSession = Boolean(state.startedAt);
  if (!hasSession) {
    ui.timerText.textContent = '--:--';
    ui.timerText.classList.remove('expired');
    return;
  }

  const elapsed = Date.now() - Number(state.startedAt);
  const remaining = EXPORT_TIME_LIMIT_MS - elapsed;
  if (remaining > 0) {
    ui.timerText.textContent = formatTimeMs(remaining);
    ui.timerText.classList.remove('expired');
  } else {
    ui.timerText.textContent = `00:00 (-${formatTimeMs(Math.abs(remaining))})`;
    ui.timerText.classList.add('expired');
  }
}

function ensureTimerRunning() {
  if (countdownTimer) return;
  countdownTimer = setInterval(() => {
    renderTimer();
  }, 1000);
}

function stopTimer() {
  if (!countdownTimer) return;
  clearInterval(countdownTimer);
  countdownTimer = null;
}

function renderSessionToggle() {
  ui.toggleSessionBtn.setAttribute('aria-expanded', String(state.sessionExpanded));
  ui.toggleSessionBtn.textContent = state.sessionExpanded ? 'Session Details (Hide)' : 'Session Details (Show)';
  ui.sessionMetaBody.classList.toggle('hidden', !state.sessionExpanded);
}

function renderMetadata() {
  ui.testerInput.value = state.metadata.tester || '';
  ui.moduleInput.value = state.metadata.module || '';
  ui.ticketInput.value = state.metadata.ticketId || '';
  ui.envInput.value = state.metadata.environment || '';
  ui.buildInput.value = state.metadata.buildVersion || '';
}

function buildCaptureCard(cap, stepNo, withNoteEditor) {
  const card = document.createElement('article');
  card.className = 'card';

  const img = document.createElement('img');
  img.src = cap.imageDataUrl;
  img.alt = `Capture ${stepNo}`;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = 'x';
  removeBtn.title = 'Delete screenshot';
  removeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    deleteCapture(cap.id);
  });

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML =
    `<div><b>Step:</b> ${stepNo}</div>` +
    `<div><b>Area:</b> ${escapeHtml(cap.area || '-')}</div>` +
    `<div><b>Tag:</b> ${escapeHtml(cap.tag || '-')}</div>` +
    `<div><b>Time:</b> ${new Date(cap.ts).toLocaleTimeString()}</div>` +
    `<div><b>Note:</b> ${escapeHtml(cap.note || '-')}</div>`;

  if (withNoteEditor) {
    const noteRow = document.createElement('div');
    noteRow.className = 'note-row';

    const noteInput = document.createElement('textarea');
    noteInput.maxLength = 500;
    noteInput.placeholder = 'Add note (pass/fail/issue, expected vs actual)';
    noteInput.value = cap.note || '';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await updateCaptureNote(cap.id, noteInput.value);
    });

    noteInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        await updateCaptureNote(cap.id, noteInput.value);
      }
    });

    noteRow.appendChild(noteInput);
    noteRow.appendChild(saveBtn);
    meta.appendChild(noteRow);
  }

  card.appendChild(img);
  card.appendChild(removeBtn);
  card.appendChild(meta);
  return card;
}

function renderGallery() {
  ui.gallery.innerHTML = '';
  if (!state.captures.length) return;

  // Keep main panel readable: show only the latest 2 captures with full visibility.
  const previewList = [...state.captures].slice(-2).reverse();
  previewList.forEach((cap, idx) => {
    const stepNo = state.captures.length - idx;
    const card = buildCaptureCard(cap, stepNo, true);
    ui.gallery.appendChild(card);
  });
}

function renderHistoryModal() {
  ui.historyGrid.innerHTML = '';
  if (!state.captures.length) {
    const empty = document.createElement('div');
    empty.className = 'history-meta';
    empty.textContent = 'No screenshots available.';
    ui.historyGrid.appendChild(empty);
    return;
  }

  const ordered = [...state.captures].reverse();
  ordered.forEach((cap, idx) => {
    const wrap = document.createElement('article');
    wrap.className = 'history-card';

    const img = document.createElement('img');
    img.src = cap.imageDataUrl;
    img.alt = `Previous screenshot ${idx + 1}`;

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.innerHTML =
      `<div><b>Step:</b> ${state.captures.length - idx}</div>` +
      `<div><b>Time:</b> ${new Date(cap.ts).toLocaleString()}</div>` +
      `<div><b>Area:</b> ${escapeHtml(cap.area || '-')}</div>` +
      `<div><b>Note:</b> ${escapeHtml(cap.note || '-')}</div>`;

    wrap.appendChild(img);
    wrap.appendChild(meta);
    ui.historyGrid.appendChild(wrap);
  });
}

function openHistoryModal() {
  if (!state.captures.length) return;
  state.modalOpen = true;
  renderHistoryModal();
  ui.historyModal.classList.remove('hidden');
}

function closeHistoryModal() {
  state.modalOpen = false;
  ui.historyModal.classList.add('hidden');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function collectMetadata() {
  return {
    tester: String(ui.testerInput.value || ''),
    module: String(ui.moduleInput.value || ''),
    ticketId: String(ui.ticketInput.value || ''),
    environment: String(ui.envInput.value || ''),
    buildVersion: String(ui.buildInput.value || '')
  };
}

function scheduleMetadataSave() {
  if (metadataSaveTimer) {
    clearTimeout(metadataSaveTimer);
  }
  metadataSaveTimer = setTimeout(() => {
    saveMetadata().catch(() => null);
  }, 250);
}

async function saveMetadata() {
  if (!state.tabId) return;
  const res = await chrome.runtime.sendMessage({
    type: 'panel:updateMetadata',
    tabId: state.tabId,
    metadata: collectMetadata()
  });
  if (res?.ok && res.metadata) {
    state.metadata = res.metadata;
  }
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

async function loadState() {
  const tab = await currentTab();
  state.tabId = tab.id;

  await chrome.runtime.sendMessage({ type: 'panel:setTab', tabId: state.tabId });
  const res = await chrome.runtime.sendMessage({ type: 'panel:getState', tabId: state.tabId });

  if (res?.ok) {
    state.recording = Boolean(res.recording);
    state.paused = Boolean(res.paused);
    state.startedAt = res.startedAt || null;
    state.captures = Array.isArray(res.captures) ? res.captures : [];
    state.metadata = Object.assign({}, state.metadata, res.metadata || {});
  }

  if (panelPort) {
    try {
      panelPort.disconnect();
    } catch (_) {
      // ignore
    }
  }
  panelPort = chrome.runtime.connect({ name: 'clicksnap:panel' });
  panelPort.onDisconnect.addListener(() => {
    panelPort = null;
  });
  panelPort.postMessage({ type: 'panel:bind', tabId: state.tabId });

  renderSessionToggle();
  renderMetadata();
  renderControls();
  renderGallery();
  ensureTimerRunning();
}

async function startRecording() {
  showError('');
  await saveMetadata().catch(() => null);

  const res = await chrome.runtime.sendMessage({ type: 'panel:start', tabId: state.tabId });
  if (!res?.ok) {
    showError(res?.error || 'Could not start recording. Refresh page once and retry.');
    return;
  }
  state.recording = true;
  state.paused = false;
  state.startedAt = res.startedAt || Date.now();
  state.captures = [];
  renderControls();
  renderGallery();
  ensureTimerRunning();
}

async function pauseResumeRecording() {
  showError('');
  if (!state.recording) return;

  if (!state.paused) {
    const res = await chrome.runtime.sendMessage({ type: 'panel:pause', tabId: state.tabId });
    if (!res?.ok) {
      showError(res?.error || 'Could not pause recording.');
      return;
    }
    state.paused = true;
  } else {
    const res = await chrome.runtime.sendMessage({ type: 'panel:resume', tabId: state.tabId });
    if (!res?.ok) {
      showError(res?.error || 'Could not resume recording.');
      return;
    }
    state.paused = false;
  }

  renderControls();
}

async function stopRecording() {
  showError('');
  const res = await chrome.runtime.sendMessage({ type: 'panel:stop', tabId: state.tabId });
  if (!res?.ok) {
    showError('Could not stop recording.');
    return;
  }
  state.recording = false;
  state.paused = false;
  renderControls();
}

async function exportWord() {
  showError('');
  await saveMetadata().catch(() => null);

  const tab = await currentTab();
  const res = await chrome.runtime.sendMessage({
    type: 'panel:exportWord',
    tabId: state.tabId,
    pageUrl: tab?.url || '',
    startedAt: state.startedAt || Date.now(),
    metadata: state.metadata,
    captures: state.captures
  });

  if (!res?.ok) {
    showError(res?.error || 'Word export failed.');
    return;
  }

  await chrome.runtime.sendMessage({ type: 'panel:stop', tabId: state.tabId }).catch(() => null);
  await chrome.runtime.sendMessage({ type: 'panel:clearCaptures', tabId: state.tabId }).catch(() => null);
  state.recording = false;
  state.paused = false;
  state.captures = [];
  state.startedAt = null;
  renderControls();
  renderGallery();
  closeHistoryModal();
  stopTimer();
}

async function updateCaptureNote(captureId, note) {
  showError('');
  const res = await chrome.runtime.sendMessage({
    type: 'panel:updateCaptureNote',
    tabId: state.tabId,
    captureId,
    note
  });
  if (!res?.ok) {
    showError(res?.error || 'Failed to save note.');
    return;
  }
  state.captures = Array.isArray(res.captures) ? res.captures : [];
  renderControls();
  renderGallery();
  if (state.modalOpen) renderHistoryModal();
}

async function deleteCapture(captureId) {
  showError('');
  const res = await chrome.runtime.sendMessage({
    type: 'panel:deleteCapture',
    tabId: state.tabId,
    captureId
  });
  if (!res?.ok) {
    showError('Failed to delete screenshot.');
    return;
  }
  state.captures = Array.isArray(res.captures) ? res.captures : [];
  renderControls();
  renderGallery();
  if (state.modalOpen) renderHistoryModal();
}

async function clearCaptures() {
  showError('');
  const res = await chrome.runtime.sendMessage({
    type: 'panel:clearCaptures',
    tabId: state.tabId
  });
  if (!res?.ok) {
    showError('Failed to clear screenshots.');
    return;
  }
  state.captures = [];
  if (!state.recording) {
    state.startedAt = null;
  }
  renderControls();
  renderGallery();
  closeHistoryModal();
  if (!state.startedAt) {
    stopTimer();
  }
}

async function closePanel() {
  if (state.captures.length > 0) {
    const ok = window.confirm('There are snapshots present. Are you sure you want to close the window?');
    if (!ok) return;
  }
  if (state.recording) {
    await chrome.runtime.sendMessage({ type: 'panel:stop', tabId: state.tabId }).catch(() => null);
    state.recording = false;
    state.paused = false;
  }
  state.allowClose = true;
  await chrome.runtime.sendMessage({ type: 'panel:close', tabId: state.tabId });
  window.close();
}

function toggleSessionDetails() {
  state.sessionExpanded = !state.sessionExpanded;
  renderSessionToggle();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'panel:newCapture') {
    if (message.tabId !== state.tabId) return;
    state.captures.push(message.capture);
    if (!state.startedAt) {
      state.startedAt = Date.now();
    }
    renderControls();
    renderGallery();
    if (state.modalOpen) renderHistoryModal();
    ensureTimerRunning();
  }

  if (message?.type === 'panel:error') {
    showError(message.message || 'Unknown error');
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  ui.start.addEventListener('click', startRecording);
  ui.pause.addEventListener('click', pauseResumeRecording);
  ui.stop.addEventListener('click', stopRecording);
  ui.exportBtn.addEventListener('click', exportWord);
  ui.clearBtn.addEventListener('click', clearCaptures);
  ui.closeBtn.addEventListener('click', closePanel);
  ui.previousBtn.addEventListener('click', openHistoryModal);
  ui.toggleSessionBtn.addEventListener('click', toggleSessionDetails);
  ui.modalCloseBtn.addEventListener('click', closeHistoryModal);
  ui.historyModal.addEventListener('click', (e) => {
    if (e.target === ui.historyModal) {
      closeHistoryModal();
    }
  });

  [ui.testerInput, ui.moduleInput, ui.ticketInput, ui.envInput, ui.buildInput].forEach((input) => {
    input.addEventListener('input', scheduleMetadataSave);
    input.addEventListener('blur', scheduleMetadataSave);
  });

  await loadState();
  renderTimer();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.modalOpen) {
    closeHistoryModal();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (state.allowClose) return;
  if (state.captures.length === 0) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener('unload', () => {
  stopTimer();
});
