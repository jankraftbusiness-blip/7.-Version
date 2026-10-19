/*
 * content.js – Kernlogik und Oberfläche der Extension.
 *
 * Ablauf:
 *  1. Chat (Text, Code, Artefakte), Anhänge und Entwurf messen und Tokens schätzen.
 *  2. Fertige Antworten als "Turn" speichern (Kontext + Ausgabe = Kosten).
 *  3. Über Zeitfenster aufsummieren -> Nutzungslimits (5 Std., Woche, ...).
 *  4. Fehlermeldungen der Seite erkennen ("Limit erreicht", "Chat zu lang") und
 *     daraus Budget und Offset für Unsichtbares kalibrieren.
 *  5. Ring + "Draft / Chat" über der Textbox, Klick öffnet die genaue Ansicht.
 */
(() => {
  'use strict';

  const CFG = window.TX_CONFIG;
  const P = CFG.providers.find((p) =>
    p.hosts.some((h) => location.hostname === h || location.hostname.endsWith('.' + h))
  );
  if (!P || window.__txLoaded) return;
  window.__txLoaded = true;
  const S = P.selectors;
  const T = CFG.timing;
  const E = CFG.estimator;

  // ---------------------------------------------------------------- Hilfen
  const qsa = (sel) => {
    try {
      return Array.from(document.querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  };
  const qs = (sel) => {
    try {
      return document.querySelector(sel);
    } catch (e) {
      return null;
    }
  };
  function findInput() {
    if (P.id !== 'chatgpt') return qs(S.input);
    const candidates = qsa(`${S.input}, textarea, [contenteditable="true"]`);
    return candidates
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          el.isConnected &&
          el.getClientRects().length > 0 &&
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      })
      .sort((a, b) => {
        const rank = (el) => {
          if (el.id === 'prompt-textarea') return 0;
          if (el.closest(S.composer)) return 1;
          if (el.closest('form')) return 2;
          if (el.getAttribute('role') === 'textbox') return 3;
          return 4;
        };
        return rank(a) - rank(b);
      })[0] || null;
  }
  function syncSurface(anchor, includeAncestors = true) {
    [ui.root, ui.panel].forEach((node) => {
      node.style.setProperty('--tx-surface', '#262624');
      node.style.setProperty('--tx-foreground', '#e8e6e0');
    });
    let el = anchor;
    while (el && el !== document.documentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      const match = bg.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const parts = match[1].split(/[,/ ]+/).filter(Boolean);
        const alpha = parts.length > 3 ? Number(parts[3]) : 1;
        if (alpha >= 0.95) {
          const [r, g, b] = parts.slice(0, 3).map(Number);
          const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          const fg = luminance < 0.5 ? '#e8e6e0' : '#202020';
          [ui.root, ui.panel].forEach((node) => {
            node.style.setProperty('--tx-surface', bg);
            node.style.setProperty('--tx-foreground', fg);
          });
          return;
        }
      }
      if (!includeAncestors) break;
      el = el.parentElement;
    }
  }
  const txt = (el) => (el ? (el.innerText !== undefined ? el.innerText : el.textContent) || '' : '');
  const outermost = (els) => els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
  const median = (a) => {
    if (!a || !a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const nf = new Intl.NumberFormat('de-DE');
  const fmtFull = (n) => nf.format(Math.round(n));
  const fmtK = (n) => {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace('.', ',') + 'k';
    return String(Math.round(n));
  };
  const fmtWin = (n) => (n >= 1e6 && n % 1e6 === 0 ? n / 1e6 + 'M' : fmtK(n));
  const fmtDuration = (ms) => {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min >= 1440) return `${Math.floor(min / 1440)} T. ${Math.floor((min % 1440) / 60)} Std.`;
    if (min >= 60) return `${Math.floor(min / 60)} Std. ${min % 60} Min.`;
    return `${min} Min.`;
  };
  const level = (pct) => (pct >= CFG.thresholds.crit ? 'crit' : pct >= CFG.thresholds.warn ? 'warn' : 'ok');
  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  // ------------------------------------------------------------- Speicher
  const store = {
    get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
    set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r))
  };
  const state = { tx_settings: {}, tx_calib: {}, tx_turns: [], tx_chats: {} };
  let loaded = false;
  let chain = Promise.resolve();

  // Lesen-Ändern-Schreiben, nacheinander, damit mehrere Tabs sich nicht überschreiben.
  function mutate(key, fn) {
    chain = chain
      .then(async () => {
        const d = await store.get(key);
        const v = fn(d[key]);
        await store.set({ [key]: v });
        state[key] = v;
      })
      .catch(() => {});
    return chain;
  }
  function persist(key) {
    chain = chain.then(() => store.set({ [key]: state[key] })).catch(() => {});
  }

  // ---------------------------------------------------- Einstellungen/Werte
  function cfgNow() {
    const s = state.tx_settings[P.id] || {};
    const plan = P.plans.find((p) => p.id === (s.plan || P.defaultPlan)) || P.plans[0];
    const calib = state.tx_calib[P.id] || {};
    const win = Number(s.contextWindow) || plan.contextWindow || P.defaultContextWindow;
    const manualOffset = s.offset !== undefined && s.offset !== '' && s.offset !== null ? Number(s.offset) : null;
    const calOffset = median(calib.offsets);
    const offset = manualOffset !== null ? manualOffset : calOffset !== null ? calOffset : P.defaultOffset;
    return { plan, win, offset, offsetCalibrated: manualOffset !== null || calOffset !== null, calib };
  }

  // ------------------------------------------------------ Token-Schätzung
  function looksGerman(text) {
    const de = (text.match(/\b(der|die|das|und|ist|nicht|ich|ein|eine|mit|für|auf|zu|den|dem|von)\b/gi) || []).length;
    const en = (text.match(/\b(the|and|is|not|of|to|with|for|that|this|you|are|in)\b/gi) || []).length;
    return de > en;
  }
  function estimateTokens(text, isCode) {
    if (!text) return 0;
    let cpt = E.codeCharsPerToken;
    if (!isCode) cpt = looksGerman(text) ? E.germanCharsPerToken : E.englishCharsPerToken;
    let wide = 0;
    for (const ch of text) if (ch.charCodeAt(0) > 0x2fff) wide++;
    return Math.ceil((text.length - wide) / cpt + wide * 1.2);
  }
  function hash(text) {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 0x01000193);
    }
    return (value >>> 0).toString(36);
  }

  const msgCache = new WeakMap();
  const msgIdentity = new WeakMap();
  function measureMessage(el) {
    const len = el.textContent.length;
    const c = msgCache.get(el);
    if (c && c.len === len) return c;
    let code = 0;
    el.querySelectorAll('pre').forEach((p) => {
      code += estimateTokens(txt(p), true);
    });
    const clone = el.cloneNode(true);
    clone.querySelectorAll('pre').forEach((n) => n.remove());
    const prose = estimateTokens(clone.textContent, false) + E.messageOverhead;
    const r = { len, prose, code };
    msgCache.set(el, r);
    return r;
  }

  function measureChat() {
    const users = outermost(qsa(S.user));
    const asst = outermost(qsa(S.assistant));
    const userSet = new Set(users);
    const messages = users.concat(asst).sort((a, b) => {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    const chat = getChat(chatKey());
    const occurrences = new Map();
    const measured = messages.map((el) => {
      const role = userSet.has(el) ? 'u' : 'a';
      const text = el.textContent || '';
      const previous = msgIdentity.get(el);
      const identity = previous && previous.role === role &&
        (text === previous.text || (previous.text && text.startsWith(previous.text)))
        ? previous.base
        : `${role}:${hash(text.slice(0, 80))}`;
      msgIdentity.set(el, { role, text, base: identity });
      const order = occurrences.get(identity) || 0;
      occurrences.set(identity, order + 1);
      return { el, role, text, identity, order, count: 0 };
    });
    measured.forEach((message) => {
      message.count = occurrences.get(message.identity);
    });
    const newMessages = chatChanges(chatKey());
    let changed = false;
    Array.from(occurrences.keys()).forEach((identity) => {
      if (occurrences.get(identity) < 2) return;
      const firstDuplicate = `${identity}#1`;
      if (chat.msgs[identity]) {
        const existing = chat.msgs[identity];
        const duplicate = chat.msgs[firstDuplicate];
        chat.msgs[firstDuplicate] = duplicate
          ? {
              role: existing.role,
              prose: Math.max(existing.prose || 0, duplicate.prose || 0),
              code: Math.max(existing.code || 0, duplicate.code || 0)
            }
          : existing;
        delete chat.msgs[identity];
        if (newMessages.delete(identity)) newMessages.add(firstDuplicate);
        changed = true;
      }
    });
    let lastAsst = 0;
    measured.forEach((message) => {
      const duplicateKey = `${message.identity}#${message.order + 1}`;
      let key = message.identity;
      if (message.count > 1) key = duplicateKey;
      else if (!chat.msgs[key] && chat.msgs[`${message.identity}#1`]) key = `${message.identity}#1`;
      const m = measureMessage(message.el);
      let saved = chat.msgs[key];
      if (!saved) {
        saved = chat.msgs[key] = { role: message.role, prose: m.prose, code: m.code };
        newMessages.add(key);
        changed = true;
      } else {
        const prose = Math.max(saved.prose || 0, m.prose);
        const code = Math.max(saved.code || 0, m.code);
        if (prose !== saved.prose || code !== saved.code) changed = true;
        saved.role = message.role;
        saved.prose = prose;
        saved.code = code;
      }
      if (message.role === 'a') lastAsst = saved.prose + saved.code;
      message.key = key;
    });
    if (changed) scheduleChatPersist();
    touchChat(chatKey(), chat);
    let artifacts = 0;
    if (S.artifact) outermost(qsa(S.artifact)).forEach((el) => (artifacts += estimateTokens(txt(el), true)));
    const prose = Object.values(chat.msgs).reduce((sum, message) => sum + message.prose, 0);
    const code = Object.values(chat.msgs).reduce((sum, message) => sum + message.code, 0);
    const lastVisible = measured[measured.length - 1] || null;
    return {
      prose,
      code,
      artifacts,
      users: users.length,
      asst: asst.length,
      lastAsst,
      lastVisible: lastVisible && { role: lastVisible.role, key: lastVisible.key, el: lastVisible.el }
    };
  }

  function isAtChatEnd(el) {
    let parent = el && el.parentElement;
    while (parent && parent !== document.documentElement) {
      const overflow = getComputedStyle(parent).overflowY;
      if (
        parent.scrollHeight > parent.clientHeight + 20 &&
        /(auto|scroll|overlay)/.test(overflow)
      ) {
        return parent.scrollHeight - parent.clientHeight - parent.scrollTop <= 120;
      }
      parent = parent.parentElement;
    }
    const scroll = document.scrollingElement || document.documentElement;
    return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 120;
  }

  function draftTokens() {
    const inp = findInput();
    if (!inp) return 0;
    const text = inp.tagName === 'TEXTAREA' || inp.tagName === 'INPUT' ? inp.value : txt(inp);
    return estimateTokens((text || '').trim(), false);
  }

  // -------------------------------------------------------------- Anhänge
  const TEXT_EXT = /\.(txt|md|csv|tsv|json|xml|yml|yaml|toml|ini|log|html?|css|scss|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|sql|r|lua)$/i;
  let pending = [];
  const seen = new Set();
  const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

  async function describeFile(file) {
    const name = file.name;
    const type = file.type || '';
    if (type.startsWith('image/')) {
      let tokens = Math.ceil(file.size / 600);
      try {
        const bmp = await createImageBitmap(file);
        tokens = E.imageTokens(P.id, bmp.width, bmp.height);
        if (bmp.close) bmp.close();
      } catch (e) {
        /* Fallback bleibt die Größenschätzung. */
      }
      return { name, kind: 'Bild', tokens, approx: true };
    }
    if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
      let pages = 1;
      try {
        const buf = await file.slice(0, 40 * 1024 * 1024).arrayBuffer();
        const raw = new TextDecoder('latin1').decode(buf);
        pages = Math.max(1, (raw.match(/\/Type\s*\/Page[^s]/g) || []).length);
      } catch (e) {
        pages = Math.max(1, Math.round(file.size / 60000));
      }
      return { name, kind: 'PDF', tokens: pages * E.pdfTokensPerPage, approx: true, pages };
    }
    if (type.startsWith('text/') || type === 'application/json' || TEXT_EXT.test(name)) {
      const text = await file.slice(0, 20 * 1024 * 1024).text();
      const isCode = /\.(js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|sql|css|scss|json|xml|html?)$/i.test(name);
      return { name, kind: 'Text', tokens: estimateTokens(text, isCode) + 20, approx: false };
    }
    return { name, kind: 'Datei', tokens: Math.min(Math.ceil(file.size / 4), 60000), approx: true };
  }

  async function addFiles(files) {
    for (const f of files) {
      const k = fileKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      try {
        pending.push(await describeFile(f));
      } catch (e) {
        pending.push({ name: f.name, kind: 'Datei', tokens: Math.ceil(f.size / 4), approx: true });
      }
    }
    scheduleRefresh();
  }
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'file' && t.files && t.files.length) addFiles(Array.from(t.files));
  }, true);
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files;
    if (f && f.length) addFiles(Array.from(f));
  }, true);
  document.addEventListener('paste', (e) => {
    const f = e.clipboardData && e.clipboardData.files;
    if (f && f.length) addFiles(Array.from(f));
  }, true);
  document.addEventListener('input', () => scheduleRefresh(), true);

  // ------------------------------------------------------ Chat-Schlüssel
  const chatKey = () => `${P.id}:${location.pathname}`;
  let lastKey = chatKey();
  let lastPath = location.pathname;
  let migrateFrom = null;
  const pendingChatChanges = new Map();
  let chatPersistTimer;

  function chatChanges(key) {
    if (!pendingChatChanges.has(key)) pendingChatChanges.set(key, new Set());
    return pendingChatChanges.get(key);
  }

  function scheduleChatPersist() {
    clearTimeout(chatPersistTimer);
    chatPersistTimer = setTimeout(() => persist('tx_chats'), 300);
  }

  function getChat(key) {
    let chat = state.tx_chats[key];
    if (!chat) {
      chat = state.tx_chats[key] = { attach: [], msgs: {}, lastSeen: Date.now() };
      scheduleChatPersist();
      pruneChats(migrateFrom);
    }
    if (!Array.isArray(chat.attach)) chat.attach = [];
    if (!chat.msgs || typeof chat.msgs !== 'object') chat.msgs = {};
    return chat;
  }

  function touchChat(key, chat) {
    const now = Date.now();
    if (!chat.lastSeen || now - chat.lastSeen >= 60000) {
      chat.lastSeen = now;
      scheduleChatPersist();
    }
    pruneChats(migrateFrom);
  }

  function pruneChats(protectedKey) {
    const ordered = Object.entries(state.tx_chats)
      .sort((a, b) => ((b[1] && b[1].lastSeen) || 0) - ((a[1] && a[1].lastSeen) || 0))
      .slice(0, 50);
    if (protectedKey && state.tx_chats[protectedKey] && !ordered.some(([chatId]) => chatId === protectedKey)) {
      ordered[ordered.length - 1] = [protectedKey, state.tx_chats[protectedKey]];
    }
    const keep = ordered;
    const retained = new Set(keep.map(([chatId]) => chatId));
    let removed = false;
    Object.keys(state.tx_chats).forEach((chatId) => {
      if (!retained.has(chatId)) {
        delete state.tx_chats[chatId];
        removed = true;
      }
    });
    if (removed) scheduleChatPersist();
  }

  function mergeChats(oldChat, currentChat) {
    const merged = { ...oldChat, ...currentChat };
    merged.attach = [...(oldChat.attach || []), ...(currentChat.attach || [])];
    merged.msgs = { ...(oldChat.msgs || {}) };
    Object.entries(currentChat.msgs || {}).forEach(([key, message]) => {
      const old = merged.msgs[key];
      merged.msgs[key] = old
        ? {
            role: message.role,
            prose: Math.max(old.prose || 0, message.prose || 0),
            code: Math.max(old.code || 0, message.code || 0)
          }
        : message;
    });
    merged.lastSeen = Math.max(oldChat.lastSeen || 0, currentChat.lastSeen || 0, Date.now());
    return merged;
  }

  function checkNavigation() {
    const key = chatKey();
    if (key === lastKey) return;
    if (pendingChatChanges.has(lastKey)) pendingChatChanges.get(lastKey).clear();
    if (P.newChatPath.test(lastPath)) {
      migrateFrom = lastKey; // Erste Nachricht in neuem Chat: Pfad wechselt auf /chat/<id>.
    } else {
      pending = [];
      seen.clear();
      migrateFrom = null;
    }
    lastKey = key;
    lastPath = location.pathname;
    scheduleSettle();
  }

  // --------------------------------------------------------- Berechnungen
  function compute() {
    const c = cfgNow();
    const m = measureChat();
    const chat = getChat(chatKey());
    const attach = chat.attach.reduce((a, f) => a + f.tokens, 0);
    const pend = pending.reduce((a, f) => a + f.tokens, 0);
    const draftText = draftTokens();
    const visible = m.prose + m.code + m.artifacts + attach;
    const chatTotal = visible + c.offset;
    const draft = draftText + pend;
    const used = chatTotal + draft;
    const range = c.offsetCalibrated ? E.rangeCalibrated : E.rangeUncalibrated;
    return {
      cfg: c,
      m,
      attach,
      attachCount: chat.attach.length,
      pend,
      pendCount: pending.length,
      draftText,
      draft,
      visible,
      chatTotal,
      used,
      window: c.win,
      pct: Math.min(1, used / c.win),
      low: used * (1 - range),
      high: used * (1 + range),
      calibrated: c.offsetCalibrated,
      windows: P.windows.map((w) => usageFor(w, c))
    };
  }

  function usageFor(w, c) {
    const now = Date.now();
    const mine = state.tx_turns.filter((t) => t.p === P.id && t.ts > now - w.ms);
    const used = mine.reduce((a, t) => a + t.cost, 0);
    const start = mine.length ? Math.min(...mine.map((t) => t.ts)) : null;
    const samples = (c.calib.budgets || {})[w.id];
    const calBudget = median(samples);
    const budget = calBudget !== null ? calBudget : (c.plan.budget || {})[w.id] || 1;
    return {
      w,
      used,
      budget,
      calibrated: calBudget !== null,
      pct: Math.min(1, used / budget),
      resetIn: start ? start + w.ms - now : null,
      turns: mine.length
    };
  }

  // ------------------------------------------------ Turns und Abrechnung
  let settleTimer;
  const baseline = new Map();
  function scheduleSettle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(onSettle, T.settleMs);
  }

  function onSettle() {
    if (!loaded) return scheduleSettle();
    if (S.streaming && qs(S.streaming)) return scheduleSettle(); // Antwort läuft noch.
    const key = chatKey();
    const m = measureChat();
    const changes = chatChanges(key);
    let chat = getChat(key);
    if (!baseline.has(key)) {
      // Erster Blick auf diesen Chat: Bestand ist kein Verbrauch.
      const fresh = migrateFrom && m.users <= 1 && m.asst <= 1;
      if (fresh) {
        const old = state.tx_chats[migrateFrom];
        if (old) {
          chat = state.tx_chats[key] = mergeChats(old, chat);
          delete state.tx_chats[migrateFrom];
          scheduleChatPersist();
        }
      } else changes.clear();
      baseline.set(key, true);
      migrateFrom = null;
    }
    const hasNewUser = Array.from(changes).some((msgKey) => chat.msgs[msgKey] && chat.msgs[msgKey].role === 'u');
    if (hasNewUser && pending.length) {
      chat.attach.push(...pending);
      scheduleChatPersist();
      pending = [];
      seen.clear();
    }
    if (
      m.lastVisible &&
      m.lastVisible.role === 'a' &&
      changes.has(m.lastVisible.key) &&
      isAtChatEnd(m.lastVisible.el)
    ) {
      const c = compute();
      const out = c.m.lastAsst;
      const ctxBefore = Math.max(0, c.chatTotal - out);
      const cost = Math.round(ctxBefore + out * CFG.usage.outputWeight);
      const turn = { ts: Date.now(), p: P.id, chat: key, ctx: Math.round(c.chatTotal), out, cost };
      state.tx_turns.push(turn);
      mutate('tx_turns', (arr) => {
        const a = (arr || []).concat([turn]);
        return a.slice(-CFG.usage.historyLimit);
      });
    }
    changes.clear();
    scheduleRefresh();
  }

  // ------------------------------------------------- Limit-Erkennung/Kalib
  const lastNotice = {};
  let lastEvent = null;

  function onNotice(kind, text) {
    const k = `${kind}|${P.id}`;
    if (Date.now() - (lastNotice[k] || 0) < T.noticeCooldownMs) return;
    lastNotice[k] = Date.now();
    const c = compute();
    if (kind === 'context') {
      const sample = Math.round(Math.min(Math.max(0, c.window - (c.visible + c.draft)), c.window * 0.5));
      mutate('tx_calib', (cal) => {
        cal = cal || {};
        const e = (cal[P.id] = cal[P.id] || {});
        e.offsets = (e.offsets || []).concat([sample]).slice(-CFG.usage.calibSamples);
        return cal;
      });
      lastEvent = { kind, ts: Date.now(), note: `Offset für Unsichtbares auf ~${fmtK(sample)} kalibriert` };
    } else {
      const weekly = /week|woche|täglich|daily|24/i.test(text);
      const w = weekly ? P.windows.find((x) => x.weekly) || P.windows[P.windows.length - 1] : P.windows[0];
      const u = usageFor(w, c.cfg);
      if (u.used > 0) {
        mutate('tx_calib', (cal) => {
          cal = cal || {};
          const e = (cal[P.id] = cal[P.id] || {});
          e.budgets = e.budgets || {};
          e.budgets[w.id] = (e.budgets[w.id] || []).concat([Math.round(u.used)]).slice(-CFG.usage.calibSamples);
          return cal;
        });
        lastEvent = { kind, ts: Date.now(), note: `Budget „${w.label}“ auf ~${fmtK(u.used)} kalibriert` };
      }
    }
    setTimeout(scheduleRefresh, 400);
  }

  const messageSel = `${S.user}, ${S.assistant}`;
  function scanNode(node) {
    if (!node || node.nodeType !== 1 || node.closest('.tx-ui')) return;
    try {
      if (node.closest(messageSel)) return; // Chat-Inhalte sind keine Fehlermeldungen.
    } catch (e) {
      /* ungültiger Selektor */
    }
    const text = (node.textContent || '').slice(0, 400);
    if (text.length < 12) return;
    if (P.patterns.context.test(text)) onNotice('context', text);
    else if (P.patterns.usage.test(text)) onNotice('usage', text);
  }

  // ------------------------------------------------------------------ UI
  const ui = { root: null, panel: null, label: null, ring: null, showBreakdown: false, open: false };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const RING_C = 2 * Math.PI * 9;

  function buildUI() {
    const root = h('div', 'tx-ui tx-root');
    root.hidden = true;
    const label = h('div', 'tx-label');
    const lDraft = h('span', 'tx-l-draft');
    const lDraftValue = h('span', 'tx-label-value');
    lDraft.append(h('span', 'tx-label-name', 'Draft'), lDraftValue);
    const lChat = h('span', 'tx-l-chat');
    const lChatValue = h('span', 'tx-label-value');
    lChat.append(h('span', 'tx-label-name', 'Chat'), lChatValue);
    label.append(lDraft, lChat);
    const btn = h('button', 'tx-ring-btn');
    btn.type = 'button';
    btn.title = 'Klicken für die genaue Ansicht';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'tx-ring');
    const track = document.createElementNS(SVGNS, 'circle');
    const prog = document.createElementNS(SVGNS, 'circle');
    [track, prog].forEach((c) => {
      c.setAttribute('cx', '12');
      c.setAttribute('cy', '12');
      c.setAttribute('r', '9');
      c.setAttribute('fill', 'none');
    });
    track.setAttribute('class', 'tx-ring-track');
    prog.setAttribute('class', 'tx-ring-prog');
    prog.setAttribute('stroke-dasharray', String(RING_C));
    svg.append(track, prog);
    btn.append(svg);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });
    root.append(label, btn);

    const panel = h('div', 'tx-ui tx-panel');
    panel.hidden = true;
    panel.addEventListener('click', (e) => e.stopPropagation());

    document.documentElement.append(root, panel);
    Object.assign(ui, { root, panel, label, lDraftValue, lChatValue, ring: prog, btn });
    document.addEventListener('click', () => ui.open && togglePanel(false));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && ui.open && togglePanel(false));
  }

  function togglePanel(force) {
    ui.open = force === undefined ? !ui.open : force;
    ui.panel.hidden = !ui.open;
    if (ui.open) refresh();
  }

  let posQueued = false;
  let chatgptLayoutTimer;
  let chatgptLayoutSnapshot = '';
  let chatgptLayoutStableSince = 0;
  let chatgptLayoutReady = false;
  function position() {
    if (posQueued) return;
    posQueued = true;
    requestAnimationFrame(() => {
      posQueued = false;
      const inp = findInput();
      if (!inp) {
        ui.root.hidden = true;
        ui.panel.hidden = true;
        return;
      }
      ui.root.classList.toggle(
        'tx-transparent',
        P.id === 'gemini' && P.newChatPath.test(location.pathname)
      );
      ui.panel.hidden = !ui.open;
      const comp =
        P.id === 'chatgpt'
          ? inp.closest(S.composer) || inp.closest('form') || inp
          : P.id === 'claude'
            ? inp.closest('fieldset') || inp.closest('form') || inp
            : (S.composer && qs(S.composer)) || inp.closest('form') || inp;
      syncSurface(P.id === 'claude' ? document.body : comp);
      let rect = comp.getBoundingClientRect();
      if (P.id === 'chatgpt' && !rect.width) rect = inp.getBoundingClientRect();
      if (P.id === 'chatgpt') {
        const snapshot = [
          comp,
          Math.round(rect.left),
          Math.round(rect.top),
          Math.round(rect.width),
          Math.round(rect.height)
        ].join('|');
        if (snapshot !== chatgptLayoutSnapshot) {
          chatgptLayoutSnapshot = snapshot;
          chatgptLayoutStableSince = Date.now();
          chatgptLayoutReady = false;
          clearTimeout(chatgptLayoutTimer);
          chatgptLayoutTimer = null;
        }
        if (!chatgptLayoutReady) {
          if (Date.now() - chatgptLayoutStableSince >= 600) {
            chatgptLayoutReady = true;
            clearTimeout(chatgptLayoutTimer);
          } else if (!chatgptLayoutTimer) {
            chatgptLayoutTimer = setTimeout(() => {
              chatgptLayoutTimer = null;
              position();
            }, 100);
          }
        }
        ui.root.hidden = !chatgptLayoutReady;
        if (!chatgptLayoutReady) ui.panel.hidden = true;
      } else {
        ui.root.hidden = false;
      }
      let left;
      let top;
      if (!rect.width) {
        left = window.innerWidth - 16;
        top = window.innerHeight - 90;
        ui.root.style.width = '';
      } else {
        left = rect.left;
        top = rect.top - 30;
        ui.root.style.width = `${rect.width}px`;
      }
      ui.root.style.left = `${left}px`;
      ui.root.style.top = `${Math.max(4, top)}px`;
      ui.panel.style.left = `${rect.width ? rect.right - 4 : left}px`;
      ui.panel.style.bottom = `${Math.max(8, window.innerHeight - top + 8)}px`;
    });
  }

  function bar(pct, extra) {
    const wrap = h('div', 'tx-bar' + (extra ? ' ' + extra : ''));
    const fill = h('div', `tx-bar-fill tx-${level(pct)}`);
    fill.style.width = `${Math.max(1, Math.round(pct * 100))}%`;
    wrap.append(fill);
    return wrap;
  }
  function line(a, b) {
    const el = h('div', 'tx-line');
    el.append(h('span', 'tx-line-k', a), h('span', 'tx-line-v', b));
    return el;
  }

  function render(c) {
    ui.lDraftValue.textContent = `~${fmtFull(c.draft)}`;
    ui.lChatValue.textContent = `~${fmtFull(c.chatTotal)} / ${fmtFull(c.window)}`;
    ui.label.className = `tx-label tx-${level(c.pct)}`;
    ui.ring.setAttribute('stroke-dashoffset', String(RING_C * (1 - c.pct)));
    ui.ring.setAttribute('class', `tx-ring-prog tx-${level(c.pct)}`);
    ui.btn.title = `Kontext ~${Math.round(c.pct * 100)} % – klicken für Details`;
    position();
    if (ui.open) renderPanel(c);
  }

  function renderPanel(c) {
    const p = ui.panel;
    p.textContent = '';

    const head = h('div', 'tx-head');
    head.append(
      h('span', 'tx-title', 'Kontextfenster'),
      h('span', 'tx-val', `~${fmtK(c.used)} / ${fmtWin(c.window)} (${Math.round(c.pct * 100)} %)`)
    );
    p.append(head, bar(c.pct));
    p.append(
      h(
        'div',
        'tx-sub',
        `Spanne ~${fmtK(c.low)}–${fmtK(c.high)} · ${c.calibrated ? 'kalibriert' : 'geschätzt'}`
      )
    );

    p.append(h('div', 'tx-sep'));
    p.append(h('div', 'tx-section', `Nutzungslimits des Plans · ${c.cfg.plan.label}`));
    c.windows.forEach((u) => {
      const row = h('div', 'tx-row');
      const top = h('div', 'tx-head');
      const reset = u.resetIn === null ? 'noch keine Nutzung' : `Zurücksetzung in ${fmtDuration(u.resetIn)}`;
      top.append(h('span', 'tx-title', u.w.label), h('span', 'tx-val', `${Math.round(u.pct * 100)} %`));
      row.append(top, bar(u.pct));
      row.append(
        h(
          'div',
          'tx-sub',
          `${reset} · ${fmtK(u.used)} Tokens${u.calibrated ? '' : ' · unkalibriert'}`
        )
      );
      p.append(row);
    });

    if (lastEvent) {
      p.append(h('div', 'tx-notice', `Zuletzt: ${lastEvent.note}`));
    }

    const toggle = h(
      'button',
      'tx-link',
      ui.showBreakdown ? 'Aufschlüsselung ausblenden' : 'Detaillierte Aufschlüsselung anzeigen'
    );
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      ui.showBreakdown = !ui.showBreakdown;
      refresh();
    });
    p.append(h('div', 'tx-sep'), toggle);

    if (ui.showBreakdown) {
      const d = h('div', 'tx-detail');
      d.append(
        line('Chat-Text (Prosa)', `~${fmtK(c.m.prose)}`),
        line('Code', `~${fmtK(c.m.code)}`),
        line(`Anhänge (${c.attachCount})`, `~${fmtK(c.attach)}`),
        line('Artefakte / Canvas', `~${fmtK(c.m.artifacts)}`),
        line(c.calibrated ? 'Unsichtbar (kalibriert)' : 'Unsichtbar (Startwert)', `~${fmtK(c.cfg.offset)}`),
        line(`Entwurf (inkl. ${c.pendCount} neue Anhänge)`, `~${fmtK(c.draft)}`)
      );
      const mine = state.tx_turns.filter((t) => t.p === P.id && t.chat === chatKey()).slice(-8);
      if (mine.length) {
        const last = mine[mine.length - 1];
        d.append(line('Letzte Antwort kostete', `~${fmtK(last.cost)}`));
        const max = Math.max(...mine.map((t) => t.cost), 1);
        const spark = h('div', 'tx-spark');
        mine.forEach((t) => {
          const b = h('div', 'tx-spark-bar');
          b.style.height = `${Math.max(6, Math.round((t.cost / max) * 100))}%`;
          b.title = `~${fmtK(t.cost)}`;
          spark.append(b);
        });
        d.append(h('div', 'tx-section', 'Verlauf pro Turn (dieser Chat)'), spark);
      }
      d.append(h('div', 'tx-sub', 'Ohne unsichtbare Denk-Tokens und ohne Nutzung auf anderen Geräten.'));

      const actions = h('div', 'tx-actions');
      const mk = (label, fn) => {
        const b = h('button', 'tx-btn', label);
        b.type = 'button';
        b.addEventListener('click', fn);
        return b;
      };
      actions.append(
        mk('Export JSON', () => exportData('json')),
        mk('Export CSV', () => exportData('csv')),
        mk('Anhänge leeren', () => {
          pending = [];
          seen.clear();
          getChat(chatKey()).attach = [];
          scheduleChatPersist();
          refresh();
        }),
        mk('Kalibrierung zurücksetzen', () => {
          mutate('tx_calib', (cal) => {
            cal = cal || {};
            delete cal[P.id];
            return cal;
          });
          lastEvent = null;
          setTimeout(refresh, 300);
        })
      );
      d.append(actions);
      p.append(d);
    }
  }

  function exportData(fmt) {
    const rows = state.tx_turns.filter((t) => t.p === P.id);
    let body;
    let mime;
    if (fmt === 'json') {
      body = JSON.stringify(rows, null, 2);
      mime = 'application/json';
    } else {
      body = ['ts,provider,chat,ctx,out,cost']
        .concat(rows.map((t) => [new Date(t.ts).toISOString(), t.p, `"${t.chat}"`, t.ctx, t.out, t.cost].join(',')))
        .join('\n');
      mime = 'text/csv';
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: mime }));
    a.download = `token-extension-${P.id}.${fmt}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------ Aktualisierung
  let refreshTimer;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, T.refreshDebounceMs);
  }
  function refresh() {
    if (!loaded || !ui.root) return;
    checkNavigation();
    render(compute());
  }

  // ---------------------------------------------------------------- Start
  async function init() {
    const d = await store.get(['tx_settings', 'tx_calib', 'tx_turns', 'tx_chats']);
    state.tx_settings = d.tx_settings || {};
    state.tx_calib = d.tx_calib || {};
    state.tx_turns = d.tx_turns || [];
    state.tx_chats = d.tx_chats || {};
    loaded = true;
    buildUI();

    new MutationObserver((muts) => {
      let relevant = false;
      for (const m of muts) {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (t && t.closest && t.closest('.tx-ui')) continue;
        relevant = true;
        m.addedNodes.forEach(scanNode);
      }
      if (relevant) {
        scheduleRefresh();
        scheduleSettle();
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.addEventListener('pageshow', scheduleRefresh);
    window.addEventListener('focus', scheduleRefresh);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleRefresh();
    });
    setInterval(refresh, T.tickMs);
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.tx_settings) state.tx_settings = ch.tx_settings.newValue || {};
      if (ch.tx_calib) state.tx_calib = ch.tx_calib.newValue || {};
      scheduleRefresh();
    });
    scheduleSettle();
    refresh();
  }
  init();
})();
