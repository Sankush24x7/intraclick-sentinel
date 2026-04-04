if (!globalThis.__clickSnapContentLoaded) {
  globalThis.__clickSnapContentLoaded = true;

  const state = {
    recording: false,
    bound: false
  };

  function elementDescriptor(el) {
    if (!el) return 'unknown';
    const tag = (el.tagName || 'unknown').toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const classes = el.classList?.length ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : '';
    return `${tag}${id}${classes}`;
  }

  function toSafeRect(rect) {
    if (!rect) return null;
    const x = Math.max(0, Math.floor(rect.left));
    const y = Math.max(0, Math.floor(rect.top));
    const width = Math.max(0, Math.ceil(rect.width));
    const height = Math.max(0, Math.ceil(rect.height));
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }

  function looksSensitive(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    const type = String(el.getAttribute?.('type') || '').toLowerCase();
    const key = [
      el.id,
      el.name,
      el.placeholder,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('autocomplete')
    ].map((v) => String(v || '').toLowerCase()).join(' ');

    if (type === 'password') return true;
    if (type === 'email') return true;
    if (tag === 'textarea' && key.includes('secret')) return true;
    if (key.includes('password') || key.includes('passwd')) return true;
    if (key.includes('otp') || key.includes('one time')) return true;
    if (key.includes('pin') || key.includes('cvv')) return true;
    if (key.includes('card') || key.includes('credit')) return true;
    if (key.includes('account') || key.includes('ifsc')) return true;
    if (String(el.getAttribute?.('autocomplete') || '').toLowerCase().includes('cc-')) return true;
    return false;
  }

  function collectSensitiveRects(target) {
    const out = [];
    if (!target) return out;

    const direct = target.closest?.('input, textarea, [contenteditable="true"], [data-sensitive]') || target;
    const candidates = [direct];

    if (direct?.form) {
      const controls = direct.form.querySelectorAll('input, textarea, [contenteditable="true"], [data-sensitive]');
      controls.forEach((el) => {
        if (looksSensitive(el)) candidates.push(el);
      });
    }

    for (const el of candidates) {
      if (!el || !looksSensitive(el)) continue;
      const rect = toSafeRect(el.getBoundingClientRect?.());
      if (rect) out.push(rect);
    }

    return out;
  }

  function clickHandler(event) {
    if (!state.recording) return;
    const target = event.target;
    const clientX = Number.isFinite(event.clientX) ? event.clientX : 0;
    const clientY = Number.isFinite(event.clientY) ? event.clientY : 0;
    const vw = Math.max(window.innerWidth || 1, 1);
    const vh = Math.max(window.innerHeight || 1, 1);
    const xPct = Math.round((clientX / vw) * 100);
    const yPct = Math.round((clientY / vh) * 100);

    let quadrant = 'center';
    const h = xPct < 34 ? 'left' : (xPct > 66 ? 'right' : 'center');
    const v = yPct < 34 ? 'top' : (yPct > 66 ? 'bottom' : 'middle');
    if (!(h === 'center' && v === 'middle')) {
      quadrant = `${v}-${h}`;
    }

    try {
      if (!chrome?.runtime?.id) return;
      const maybePromise = chrome.runtime.sendMessage({
        type: 'content:click',
        payload: {
          url: location.href,
          area: `${quadrant} (x:${clientX}, y:${clientY}, ${xPct}%, ${yPct}%)`,
          tag: elementDescriptor(target),
          sensitiveRects: collectSensitiveRects(target)
        }
      });
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {
        // Ignore transient messaging failures when extension context refreshes.
        });
      }
    } catch (_) {
      // Ignore "Extension context invalidated" and similar transient runtime errors.
    }
  }

  function ensureBound() {
    if (state.bound) return;
    state.bound = true;
    document.addEventListener('click', clickHandler, true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'clicksnap:ping') {
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'clicksnap:start') {
      ensureBound();
      state.recording = true;
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'clicksnap:stop') {
      state.recording = false;
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });
}
