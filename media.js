'use strict';

const UNSUPPORTED_MEDIA_MESSAGE = 'This source cannot be played by Zenith. Use a supported direct video URL or authorized embed.';
const DIRECT_VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogv']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);

function youtubeVideoId(url) {
  if (url.hostname === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
  if (url.hostname === 'www.youtube-nocookie.com') return url.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})\/?$/)?.[1] || null;
  if (url.pathname === '/watch') return url.searchParams.get('v');
  return url.pathname.match(/^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/)?.[1] || null;
}

function vimeoVideoId(url) {
  const match = url.pathname.match(/^\/(?:video\/)?(\d+)\/?$/);
  return match?.[1] || null;
}

function classifyMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error(UNSUPPORTED_MEDIA_MESSAGE);
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(UNSUPPORTED_MEDIA_MESSAGE);
  }

  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) {
    const id = youtubeVideoId(url);
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
      return {
        provider: 'youtube',
        source_url: url.toString(),
        embed_url: `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1`,
        provider_id: id,
      };
    }
  }

  if (VIMEO_HOSTS.has(host)) {
    const id = vimeoVideoId(url);
    if (id) {
      return {
        provider: 'vimeo',
        source_url: url.toString(),
        embed_url: `https://player.vimeo.com/video/${id}?api=1`,
        provider_id: id,
      };
    }
  }

  const extension = url.pathname.slice(url.pathname.lastIndexOf('.')).toLowerCase();
  if (DIRECT_VIDEO_EXTENSIONS.has(extension)) {
    return { provider: 'direct_video', source_url: url.toString(), embed_url: null, provider_id: null };
  }

  throw new Error(UNSUPPORTED_MEDIA_MESSAGE);
}

module.exports = { UNSUPPORTED_MEDIA_MESSAGE, classifyMediaUrl };