(function () {
  'use strict';

  const P = globalThis.StreamParse;
  const STATUS_TIMEOUT_MS = 6000;
  const GRID_PADDING_PX = 4;
  const STREAM_PARTITION = 'persist:streams';

  const byId = (id) => document.getElementById(id);
  const els = {
    input: byId('stream-input'),
    addBtn: byId('add-btn'),
    counter: byId('counter'),
    muteAllBtn: byId('mute-all-btn'),
    reloadAllBtn: byId('reload-all-btn'),
    clearBtn: byId('clear-btn'),
    status: byId('status'),
    grid: byId('grid'),
    empty: byId('empty-state'),
  };

  let state = Object.freeze({ streams: Object.freeze([]), audioKey: null, spotlightKey: null });
  const tiles = new Map(); // key -> { root, webview, audioBtn, spotBtn, stream }
  const readyKeys = new Set();
  let dragKey = null;
  let statusTimer = 0;
  let layoutFrame = 0;

  // ---------- state ----------

  function setState(patch, persist) {
    state = Object.freeze({ ...state, ...patch });
    render();
    if (persist) persistStreams();
  }

  function persistStreams() {
    const list = state.streams.map(({ platform, channel }) => ({ platform, channel }));
    window.api.saveStreams(list).catch(() => showStatus('Liste kaydedilemedi.', 'error'));
  }

  function findStream(key) {
    return state.streams.find((s) => P.streamKey(s) === key) || null;
  }

  function sanitizeLoaded(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list.filter((s) => {
      if (!P.isValidStream(s) || seen.has(P.streamKey(s))) return false;
      seen.add(P.streamKey(s));
      return true;
    }).slice(0, P.MAX_STREAMS).map((s) => Object.freeze({ platform: s.platform, channel: s.channel }));
  }

  // ---------- status ----------

  function showStatus(message, kind) {
    clearTimeout(statusTimer);
    els.status.textContent = message;
    els.status.title = message;
    els.status.className = `status status--${kind || 'info'}`;
    statusTimer = setTimeout(() => {
      els.status.textContent = '';
      els.status.title = '';
    }, STATUS_TIMEOUT_MS);
  }

  // ---------- adding ----------

  function collectNewStreams(parts) {
    const keys = new Set(state.streams.map(P.streamKey));
    const result = { added: [], errors: [], failed: [] };
    for (const raw of parts) {
      try {
        const stream = P.parseStreamInput(raw);
        const key = P.streamKey(stream);
        if (keys.has(key)) throw new Error(`${stream.channel} (${stream.platform}) zaten ekli.`);
        if (keys.size >= P.MAX_STREAMS) throw new Error(`En fazla ${P.MAX_STREAMS} yayın eklenebilir.`);
        keys.add(key);
        result.added.push(stream);
      } catch (err) {
        result.errors.push(err.message);
        result.failed.push(raw);
      }
    }
    return result;
  }

  function handleAdd() {
    const parts = P.splitInput(els.input.value);
    if (parts.length === 0) {
      showStatus('Bir Twitch/Kick linki veya kanal adı girin.', 'error');
      return;
    }
    const { added, errors, failed } = collectNewStreams(parts);
    if (added.length > 0) {
      setState({ streams: Object.freeze([...state.streams, ...added]) }, true);
    }
    if (errors.length > 0) {
      els.input.value = failed.join(' ');
      const prefix = added.length > 0 ? `${added.length} yayın eklendi. ` : '';
      showStatus(prefix + [...new Set(errors)].join(' • '), 'error');
      return;
    }
    els.input.value = '';
    showStatus(`${added.length} yayın eklendi.`, 'ok');
  }

  function handlePaste(event) {
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    if (!/[\r\n]/.test(text)) return;
    // <input> strips newlines on paste, which would glue multiple links together.
    event.preventDefault();
    const input = els.input;
    input.setRangeText(text.replace(/[\r\n]+/g, ' ').trim(), input.selectionStart, input.selectionEnd, 'end');
  }

  // ---------- actions ----------

  function toggleAudio(key) {
    setState({ audioKey: state.audioKey === key ? null : key });
  }

  function toggleSpotlight(key) {
    setState({ spotlightKey: state.spotlightKey === key ? null : key });
  }

  function muteAll() {
    setState({ audioKey: null });
  }

  function removeStream(key) {
    setState({
      streams: Object.freeze(state.streams.filter((s) => P.streamKey(s) !== key)),
      audioKey: state.audioKey === key ? null : state.audioKey,
      spotlightKey: state.spotlightKey === key ? null : state.spotlightKey,
    }, true);
  }

  function swapStreams(keyA, keyB) {
    const keys = state.streams.map(P.streamKey);
    const i = keys.indexOf(keyA);
    const j = keys.indexOf(keyB);
    if (i < 0 || j < 0 || i === j) return;
    const next = state.streams.map((s, idx) => {
      if (idx === i) return state.streams[j];
      if (idx === j) return state.streams[i];
      return s;
    });
    setState({ streams: Object.freeze(next) }, true);
  }

  function reloadTile(key) {
    const tile = tiles.get(key);
    if (!tile) return;
    if (readyKeys.has(key)) {
      tile.webview.reload();
    } else {
      tile.webview.src = P.buildPlayerUrl(tile.stream);
    }
  }

  function reloadAll() {
    tiles.forEach((_tile, key) => reloadTile(key));
  }

  function openChat(key) {
    const stream = findStream(key);
    if (stream) window.open(P.buildChatUrl(stream), '_blank');
  }

  function clearAll() {
    if (state.streams.length === 0) return;
    if (!window.confirm('Tüm yayınlar kaldırılsın mı?')) return;
    setState({ streams: Object.freeze([]), audioKey: null, spotlightKey: null }, true);
  }

  // ---------- tile creation ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconButton(icon, title, onClick, extraClass) {
    const btn = el('button', `icon-btn${extraClass ? ` ${extraClass}` : ''}`, icon);
    btn.type = 'button';
    btn.title = title;
    btn.draggable = false;
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  function createHeader(stream, key) {
    const header = el('div', 'tile__header');
    header.draggable = true;
    header.title = 'Sürükleyerek yer değiştirin · Çift tıklayarak büyütün';
    const badge = el('span', `badge badge--${stream.platform}`, stream.platform.toUpperCase());
    const name = el('span', 'tile__name', stream.channel);
    const actions = el('div', 'tile__actions');
    const audioBtn = iconButton('🔇', 'Sesi aç (diğerleri susturulur)', () => toggleAudio(key));
    const spotBtn = iconButton('⤢', 'Büyüt', () => toggleSpotlight(key));
    actions.append(
      audioBtn,
      spotBtn,
      iconButton('⟳', 'Yenile', () => reloadTile(key)),
      iconButton('💬', 'Sohbeti tarayıcıda aç', () => openChat(key)),
      iconButton('✕', 'Kaldır', () => removeStream(key), 'icon-btn--danger'),
    );
    header.append(badge, name, actions);
    header.addEventListener('dblclick', (event) => {
      if (!event.target.closest('button')) toggleSpotlight(key);
    });
    return { header, audioBtn, spotBtn };
  }

  function createWebview(stream, key) {
    const webview = document.createElement('webview');
    webview.setAttribute('partition', STREAM_PARTITION);
    webview.setAttribute('allowpopups', '');
    webview.setAttribute('useragent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    if (stream.platform === 'youtube') {
      webview.setAttribute('httpreferrer', 'https://www.youtube.com/');
    }
    webview.setAttribute('src', P.buildPlayerUrl(stream));
    webview.addEventListener('dom-ready', () => {
      readyKeys.add(key);
      applyAudioState();
      if (stream.platform === 'youtube') {
        webview.insertCSS(`
          #masthead-container, #secondary, #below, #chat-container, ytd-miniplayer, #comments, #chips,
          ytd-consent-bump-v2-lightbox, tp-yt-paper-dialog, ytd-popup-container {
            display: none !important;
          }
          html, body { overflow: hidden !important; background: #000 !important; }
          #page-manager { margin-top: 0 !important; }
          ytd-watch-flexy { padding: 0 !important; margin: 0 !important; }
          #player, #ytd-player, .html5-video-player {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            z-index: 999999 !important;
          }
          video.html5-main-video {
            width: 100% !important;
            height: 100% !important;
            object-fit: contain !important;
          }
        `).catch(() => {});
        webview.executeJavaScript(`
          (function() {
            const v = document.querySelector('video');
            if (v && v.paused) v.play().catch(() => {});
          })();
        `).catch(() => {});
      }
    });
    webview.addEventListener('render-process-gone', () => {
      readyKeys.delete(key);
      showStatus(`${stream.channel} oynatıcısı çöktü — ⟳ ile yenileyin.`, 'error');
    });
    return webview;
  }

  function createTile(stream) {
    const key = P.streamKey(stream);
    const root = el('div', `tile tile--${stream.platform}`);
    root.dataset.key = key;
    const { header, audioBtn, spotBtn } = createHeader(stream, key);
    const body = el('div', 'tile__body');
    const webview = createWebview(stream, key);
    body.appendChild(webview);
    root.append(header, body);
    attachDragHandlers(root, header, key);
    return { root, webview, audioBtn, spotBtn, stream };
  }

  // ---------- drag & drop reorder ----------

  function clearDropTargets() {
    els.grid.querySelectorAll('.tile--drop-target').forEach((n) => n.classList.remove('tile--drop-target'));
  }

  function endDrag() {
    dragKey = null;
    els.grid.classList.remove('grid--dragging');
    els.grid.querySelectorAll('.tile--dragging').forEach((n) => n.classList.remove('tile--dragging'));
    clearDropTargets();
  }

  function attachDragHandlers(root, header, key) {
    header.addEventListener('dragstart', (event) => {
      dragKey = key;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', key);
      root.classList.add('tile--dragging');
      els.grid.classList.add('grid--dragging'); // lets drag events pass over webviews
    });
    header.addEventListener('dragend', endDrag);
    root.addEventListener('dragover', (event) => {
      if (!dragKey || dragKey === key) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      root.classList.add('tile--drop-target');
    });
    root.addEventListener('dragleave', (event) => {
      if (!root.contains(event.relatedTarget)) root.classList.remove('tile--drop-target');
    });
    root.addEventListener('drop', (event) => {
      event.preventDefault();
      const source = dragKey;
      endDrag();
      if (source && source !== key) swapStreams(source, key);
    });
  }

  // ---------- rendering ----------

  function syncTiles() {
    const keys = new Set(state.streams.map(P.streamKey));
    tiles.forEach((tile, key) => {
      if (keys.has(key)) return;
      tile.root.remove();
      tiles.delete(key);
      readyKeys.delete(key);
    });
    state.streams.forEach((stream) => {
      const key = P.streamKey(stream);
      if (tiles.has(key)) return;
      const tile = createTile(stream);
      tiles.set(key, tile);
      els.grid.appendChild(tile.root); // never moved afterwards: moving a webview reloads it
    });
  }

  function placeTile(key, placement) {
    const tile = tiles.get(key);
    if (!tile) return;
    const style = tile.root.style;
    style.order = String(placement.order);
    style.gridColumn = placement.column;
    style.gridRow = placement.row;
    tile.root.classList.toggle('tile--spotlight', placement.mode === 'spotlight');
    tile.root.classList.toggle('tile--strip', placement.mode === 'strip');
    tile.spotBtn.title = placement.mode === 'spotlight' ? 'Küçült (Esc)' : 'Büyüt';
  }

  function layoutGrid(keys) {
    const width = els.grid.clientWidth - GRID_PADDING_PX * 2;
    const height = els.grid.clientHeight - GRID_PADDING_PX * 2;
    const { cols, rows } = P.gridDimensions(keys.length, width, height);
    els.grid.style.gridTemplateColumns = cols ? `repeat(${cols}, minmax(0, 1fr))` : '';
    els.grid.style.gridTemplateRows = rows ? `repeat(${rows}, minmax(0, 1fr))` : '';
    keys.forEach((key, i) => placeTile(key, { order: i, column: '', row: '', mode: '' }));
  }

  function layoutSpotlight(keys, spotKey) {
    const others = keys.filter((k) => k !== spotKey);
    els.grid.style.gridTemplateColumns = `repeat(${Math.max(others.length, 1)}, minmax(0, 1fr))`;
    els.grid.style.gridTemplateRows = others.length ? 'minmax(0, 4fr) minmax(0, 1fr)' : 'minmax(0, 1fr)';
    placeTile(spotKey, { order: 0, column: '1 / -1', row: '1', mode: 'spotlight' });
    others.forEach((key, i) => {
      placeTile(key, { order: i + 1, column: String(i + 1), row: '2', mode: 'strip' });
    });
  }

  function applyLayout() {
    const keys = state.streams.map(P.streamKey);
    if (keys.includes(state.spotlightKey)) {
      layoutSpotlight(keys, state.spotlightKey);
    } else {
      layoutGrid(keys);
    }
  }

  function applyAudioState() {
    tiles.forEach((tile, key) => {
      const muted = key !== state.audioKey;
      tile.audioBtn.textContent = muted ? '🔇' : '🔊';
      tile.audioBtn.title = muted ? 'Sesi aç (diğerleri susturulur)' : 'Sesi kapat';
      tile.root.classList.toggle('tile--audio', !muted);
      if (!readyKeys.has(key)) return;
      try {
        tile.webview.setAudioMuted(muted);
      } catch (err) {
        readyKeys.delete(key);
      }
    });
  }

  function updateToolbar() {
    const count = state.streams.length;
    els.counter.textContent = `${count}/${P.MAX_STREAMS}`;
    els.counter.classList.toggle('counter--full', count >= P.MAX_STREAMS);
    els.empty.hidden = count > 0;
    els.clearBtn.disabled = count === 0;
    els.reloadAllBtn.disabled = count === 0;
    els.muteAllBtn.disabled = state.audioKey === null;
  }

  function render() {
    syncTiles();
    applyLayout();
    applyAudioState();
    updateToolbar();
  }

  function scheduleLayout() {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(applyLayout);
  }

  // ---------- init ----------

  function handleKeydown(event) {
    if (event.key === 'Escape' && state.spotlightKey) {
      setState({ spotlightKey: null });
    } else if (event.ctrlKey && event.code === 'KeyL') {
      event.preventDefault();
      els.input.focus();
      els.input.select();
    } else if (event.ctrlKey && event.code === 'KeyM') {
      event.preventDefault();
      muteAll();
    }
  }

  function bindEvents() {
    els.addBtn.addEventListener('click', handleAdd);
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') handleAdd();
    });
    els.input.addEventListener('paste', handlePaste);
    els.muteAllBtn.addEventListener('click', muteAll);
    els.reloadAllBtn.addEventListener('click', reloadAll);
    els.clearBtn.addEventListener('click', clearAll);
    document.addEventListener('keydown', handleKeydown);
    new ResizeObserver(scheduleLayout).observe(els.grid);
  }

  async function init() {
    bindEvents();
    render();
    try {
      const list = await window.api.loadStreams();
      setState({ streams: Object.freeze(sanitizeLoaded(list)) });
    } catch (err) {
      showStatus('Kayıtlı yayınlar yüklenemedi.', 'error');
    }
    els.input.focus();
  }

  init();
})();
