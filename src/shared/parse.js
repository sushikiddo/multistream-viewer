/*
 * Pure, dependency-free helpers shared by the main process (CommonJS),
 * the renderer (<script>, exposed as globalThis.StreamParse) and tests.
 */
(function () {
  'use strict';

  const MAX_STREAMS = 16;
  const TILE_HEADER_PX = 28;

  const CHANNEL_PATTERNS = Object.freeze({
    twitch: /^[a-z0-9_]{1,25}$/,
    kick: /^[a-z0-9_-]{1,30}$/,
    youtube: /^[a-zA-Z0-9_./@ -]{1,80}$/,
  });

  const PLATFORM_LABELS = Object.freeze({ twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' });

  const RESERVED_PATHS = Object.freeze({
    twitch: new Set([
      'directory', 'videos', 'settings', 'search', 'p', 'downloads', 'jobs',
      'turbo', 'login', 'signup', 'subscriptions', 'inventory', 'wallet', 'drops',
    ]),
    kick: new Set([
      'categories', 'search', 'following', 'browse', 'dashboard',
      'terms-of-service', 'privacy-policy',
    ]),
  });

  const HOST_PLATFORMS = Object.freeze({
    'twitch.tv': 'twitch',
    'kick.com': 'kick',
    'player.kick.com': 'kick',
    'youtube.com': 'youtube',
    'youtu.be': 'youtube',
  });

  const SHORTHAND_PLATFORMS = Object.freeze({
    twitch: 'twitch',
    t: 'twitch',
    kick: 'kick',
    k: 'kick',
    youtube: 'youtube',
    yt: 'youtube',
    y: 'youtube',
  });

  function isValidStream(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const pattern = CHANNEL_PATTERNS[obj.platform];
    if (!pattern || !Object.prototype.hasOwnProperty.call(CHANNEL_PATTERNS, obj.platform)) {
      return false;
    }
    return typeof obj.channel === 'string' && pattern.test(obj.channel);
  }

  function streamKey(stream) {
    return `${stream.platform}:${stream.channel}`;
  }

  function makeStream(platform, raw) {
    let channel = String(raw == null ? '' : raw).trim();
    if (platform !== 'youtube') {
      channel = channel.replace(/^@/, '').toLowerCase();
    }
    if (!channel) {
      throw new Error(`${PLATFORM_LABELS[platform]} kanal adı veya video ID boş.`);
    }
    if (!CHANNEL_PATTERNS[platform].test(channel)) {
      throw new Error(`Geçersiz ${PLATFORM_LABELS[platform]} kanal adı / linki: "${raw}"`);
    }
    return Object.freeze({ platform, channel });
  }

  function parseShorthand(text) {
    const match = /^([a-z]+):(?!\/\/)(.*)$/i.exec(text);
    if (!match) return null;
    const platform = SHORTHAND_PLATFORMS[match[1].toLowerCase()];
    if (!platform) return null;
    return makeStream(platform, match[2]);
  }

  function toUrl(text) {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
    try {
      return new URL(hasScheme ? text : `https://${text}`);
    } catch (err) {
      throw new Error(`Geçersiz bağlantı: "${text}"`);
    }
  }

  function firstPathSegment(pathname) {
    const segment = pathname.split('/').filter(Boolean)[0] || '';
    try {
      return decodeURIComponent(segment).toLowerCase();
    } catch (err) {
      return segment.toLowerCase();
    }
  }

  function parseUrl(text) {
    const unsupported = new Error('Desteklenmeyen bağlantı: yalnızca Twitch, Kick ve YouTube desteklenir.');
    const url = toUrl(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw unsupported;
    const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    if (host === 'player.twitch.tv') {
      return makeStream('twitch', url.searchParams.get('channel') || '');
    }

    if (host === 'youtu.be') {
      const id = firstPathSegment(url.pathname);
      if (!id) throw new Error('YouTube video ID bulunamadı.');
      return makeStream('youtube', id);
    }

    if (host === 'youtube.com') {
      const v = url.searchParams.get('v');
      if (v) return makeStream('youtube', v);
      const segments = url.pathname.split('/').filter(Boolean);
      const first = segments[0] ? segments[0].toLowerCase() : '';
      if ((first === 'live' || first === 'embed' || first === 'shorts') && segments[1]) {
        return makeStream('youtube', segments[1]);
      }
      if (segments[0] && segments[0].startsWith('@')) {
        return makeStream('youtube', segments.join('/'));
      }
      if ((first === 'c' || first === 'channel') && segments[1]) {
        return makeStream('youtube', segments.join('/'));
      }
      const segment = firstPathSegment(url.pathname);
      if (segment) return makeStream('youtube', segment);
      throw new Error('Bağlantıda YouTube video ID veya kanal adı bulunamadı.');
    }

    const platform = HOST_PLATFORMS[host];
    if (!platform) throw unsupported;
    const segment = firstPathSegment(url.pathname);
    if (!segment) throw new Error('Bağlantıda kanal adı bulunamadı.');
    if (RESERVED_PATHS[platform] && RESERVED_PATHS[platform].has(segment)) {
      throw new Error(`"${segment}" bir kanal değil; lütfen bir ${PLATFORM_LABELS[platform]} kanal linki girin.`);
    }
    return makeStream(platform, segment);
  }

  /**
   * Parses a Twitch/Kick/YouTube URL, shorthand ("twitch:name", "k:name", "yt:id") or a bare
   * channel name (defaults to Twitch). Throws Error with a Turkish message.
   */
  function parseStreamInput(input) {
    const text = String(input == null ? '' : input).trim();
    if (!text) throw new Error('Boş giriş: bir link veya kanal adı yazın.');
    const shorthand = parseShorthand(text);
    if (shorthand) return shorthand;
    if (/[./]/.test(text)) return parseUrl(text);
    return makeStream('twitch', text);
  }

  /** Splits pasted text containing several links (whitespace, commas, semicolons). */
  function splitInput(text) {
    return String(text == null ? '' : text).split(/[\s,;]+/).filter(Boolean);
  }

  function buildPlayerUrl(stream) {
    const channel = encodeURIComponent(stream.channel);
    if (stream.platform === 'twitch') {
      return `https://player.twitch.tv/?channel=${channel}&parent=localhost&muted=false&autoplay=true`;
    }
    if (stream.platform === 'kick') {
      return `https://player.kick.com/${channel}?muted=false&autoplay=true`;
    }
    if (stream.platform === 'youtube') {
      if (stream.channel.startsWith('@') || stream.channel.includes('/')) {
        const path = stream.channel.endsWith('/live') ? stream.channel : `${stream.channel}/live`;
        return `https://www.youtube.com/${path}`;
      }
      return `https://www.youtube.com/watch?v=${channel}&autoplay=1`;
    }
    throw new Error(`Bilinmeyen platform: ${stream.platform}`);
  }

  function buildChatUrl(stream) {
    const channel = encodeURIComponent(stream.channel);
    if (stream.platform === 'twitch') return `https://www.twitch.tv/popout/${channel}/chat`;
    if (stream.platform === 'kick') return `https://kick.com/popout/${channel}/chat`;
    if (stream.platform === 'youtube') {
      if (stream.channel.startsWith('@') || stream.channel.includes('/')) {
        return `https://www.youtube.com/${stream.channel}`;
      }
      return `https://www.youtube.com/live_chat?is_popout=1&v=${channel}`;
    }
    throw new Error(`Bilinmeyen platform: ${stream.platform}`);
  }

  function videoArea(tileWidth, tileHeight) {
    if (tileWidth <= 0 || tileHeight <= 0) return 0;
    const videoWidth = Math.min(tileWidth, (tileHeight * 16) / 9);
    return (videoWidth * videoWidth * 9) / 16;
  }

  /**
   * Picks the column count that maximizes the visible 16:9 video area per tile
   * (each tile loses TILE_HEADER_PX of height to its header).
   */
  function gridDimensions(n, width, height) {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    if (count === 0) return { cols: 0, rows: 0 };
    const w = Number(width);
    const h = Number(height);
    if (!(w > 0 && h > 0)) {
      const cols = Math.ceil(Math.sqrt(count));
      return { cols, rows: Math.ceil(count / cols) };
    }
    let best = { cols: 1, rows: count, area: -1 };
    for (let cols = 1; cols <= count; cols += 1) {
      const rows = Math.ceil(count / cols);
      const area = videoArea(w / cols, h / rows - TILE_HEADER_PX);
      if (area > best.area) best = { cols, rows, area };
    }
    return { cols: best.cols, rows: best.rows };
  }

  const api = Object.freeze({
    MAX_STREAMS,
    TILE_HEADER_PX,
    parseStreamInput,
    splitInput,
    buildPlayerUrl,
    buildChatUrl,
    isValidStream,
    streamKey,
    gridDimensions,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    globalThis.StreamParse = api;
  }
})();
