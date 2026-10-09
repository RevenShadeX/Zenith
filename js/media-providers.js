'use strict';

const providerScripts = new Map();
let embedPlayerSequence = 0;

function loadScript(source, ready) {
  if (ready()) return Promise.resolve();
  if (providerScripts.has(source)) return providerScripts.get(source);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = source;
    script.async = true;
    script.onload = () => ready() ? resolve() : reject(new Error('The authorized media player did not initialize.'));
    script.onerror = () => reject(new Error('The authorized media player could not be loaded.'));
    document.head.append(script);
  });
  providerScripts.set(source, promise);
  return promise;
}

function loadYouTubeApi() {
  const source = 'https://www.youtube.com/iframe_api';
  if (window.YT?.Player) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('YouTube player timed out.')), 12000);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout);
      previous?.();
      resolve();
    };
    if (!document.querySelector(`script[src="${source}"]`)) {
      const script = document.createElement('script');
      script.src = source;
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('YouTube player could not be loaded.'));
      };
      document.head.append(script);
    }
  });
}

function loadVimeoApi() {
  return loadScript('https://player.vimeo.com/api/player.js', () => Boolean(window.Vimeo?.Player));
}

class DirectVideoProvider {
  constructor(media, { host, onAction }) {
    this.media = media;
    this.host = host;
    this.onAction = onAction;
    this.applying = false;
    this.video = null;
  }

  mount(container) {
    const video = document.createElement('video');
    video.className = 'watch-video';
    video.controls = this.host;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = this.media.source_url;
    video.addEventListener('play', () => this.emit('play'));
    video.addEventListener('pause', () => this.emit('pause'));
    video.addEventListener('seeked', () => this.emit('seek'));
    video.addEventListener('ended', () => this.emit('ended'));
    video.addEventListener('error', () => this.showError(container));
    this.video = video;
    container.replaceChildren(video);
  }

  emit(action) {
    if (this.host && !this.applying && this.video) this.onAction(action, this.video.currentTime);
  }

  getCurrentTime() {
    return this.video ? this.video.currentTime : null;
  }

  async apply(action, position) {
    if (!this.video) return;
    this.applying = true;
    try {
      if (action === 'seek') this.video.currentTime = position;
      if (action === 'sync' && Math.abs(this.video.currentTime - position) > 0.75) this.video.currentTime = position;
      if (action === 'play') {
        this.video.currentTime = position;
        await this.video.play();
      }
      if (action === 'pause') {
        this.video.pause();
        if (Math.abs(this.video.currentTime - position) > 0.35) this.video.currentTime = position;
      }
    } catch {
      document.querySelector('#playbackHint')?.classList.remove('is-hidden');
    } finally {
      window.setTimeout(() => { this.applying = false; }, 350);
    }
  }

  async enablePlayback() {
    try {
      await this.video?.play();
      document.querySelector('#playbackHint')?.classList.add('is-hidden');
    } catch {
      document.querySelector('#playbackHint')?.classList.remove('is-hidden');
    }
  }

  showError(container) {
    const error = document.createElement('div');
    error.className = 'player-error';
    error.textContent = 'This video could not be loaded. Check that the host shared a playable direct video URL.';
    container.append(error);
  }

  destroy() {
    this.video?.pause();
    this.video?.removeAttribute('src');
    this.video?.load();
    this.video = null;
  }
}

class EmbedProvider {
  constructor(media, { host, onAction }) {
    this.media = media;
    this.host = host;
    this.onAction = onAction;
    this.applying = false;
    this.player = null;
    this.iframe = null;
    this.lastPosition = 0;
  }

  async mount(container) {
    const iframe = document.createElement('iframe');
    const url = new URL(this.media.embed_url);
    url.searchParams.set('controls', this.host ? '1' : '0');
    url.searchParams.set('autoplay', '0');
    url.searchParams.set('origin', window.location.origin);
    iframe.src = url.toString();
    iframe.title = 'Authorized embedded watch party media';
    iframe.id = `zenith-embed-player-${++embedPlayerSequence}`;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.className = 'watch-embed';
    this.iframe = iframe;
    container.replaceChildren(iframe);

    if (this.media.provider === 'youtube') await this.mountYouTube(iframe);
    else if (this.media.provider === 'vimeo') await this.mountVimeo(iframe);
    else throw new Error('Unsupported authorized embed provider.');
  }

  async mountYouTube(iframe) {
    await loadYouTubeApi();
    await new Promise((resolve, reject) => {
      this.player = new window.YT.Player(iframe.id, {
        events: {
          onReady: resolve,
          onError: () => reject(new Error('This YouTube embed is unavailable or does not allow playback.')),
          onStateChange: (event) => {
            if (!this.host || this.applying) return;
            const position = event.target.getCurrentTime();
            if (event.data === window.YT.PlayerState.ENDED) {
              this.emit('ended', position);
            } else if (event.data === window.YT.PlayerState.PLAYING) {
              this.emit(Math.abs(position - this.lastPosition) > 1.2 ? 'seek' : 'play', position);
            } else if (event.data === window.YT.PlayerState.PAUSED) {
              this.emit(Math.abs(position - this.lastPosition) > 1.2 ? 'seek' : 'pause', position);
            }
            this.lastPosition = position;
          },
        },
      });
    });
  }

  async mountVimeo(iframe) {
    await loadVimeoApi();
    this.player = new window.Vimeo.Player(iframe);
    await this.player.ready();
    this.player.on('play', async () => this.emit('play', await this.player.getCurrentTime()));
    this.player.on('pause', async () => this.emit('pause', await this.player.getCurrentTime()));
    this.player.on('seeked', (event) => this.emit('seek', event.seconds));
    this.player.on('ended', async () => this.emit('ended', await this.player.getCurrentTime()));
  }

  emit(action, position) {
    if (this.host && !this.applying && Number.isFinite(Number(position))) {
      this.lastPosition = Number(position);
      this.onAction(action, Number(position));
    }
  }

  async getCurrentTime() {
    if (!this.player) return null;
    return await this.player.getCurrentTime();
  }

  async apply(action, position) {
    if (!this.player) return;
    this.applying = true;
    try {
      if (this.media.provider === 'youtube') {
        if (action === 'seek') this.player.seekTo(position, true);
        if (action === 'sync' && Math.abs(this.player.getCurrentTime() - position) > 0.75) this.player.seekTo(position, true);
        if (action === 'play') {
          this.player.seekTo(position, true);
          this.player.playVideo();
        }
        if (action === 'pause') {
          this.player.pauseVideo();
          if (Math.abs(this.player.getCurrentTime() - position) > 0.75) this.player.seekTo(position, true);
        }
      } else {
        if (action === 'seek') await this.player.setCurrentTime(position);
        if (action === 'sync' && Math.abs(await this.player.getCurrentTime() - position) > 0.75) await this.player.setCurrentTime(position);
        if (action === 'play') {
          await this.player.setCurrentTime(position);
          await this.player.play();
        }
        if (action === 'pause') {
          await this.player.pause();
          if (Math.abs(await this.player.getCurrentTime() - position) > 0.75) await this.player.setCurrentTime(position);
        }
      }
    } catch {
      document.querySelector('#playbackHint')?.classList.remove('is-hidden');
    } finally {
      window.setTimeout(() => { this.applying = false; }, 500);
    }
  }

  async enablePlayback() {
    try {
      if (this.media.provider === 'youtube') this.player?.playVideo();
      else await this.player?.play();
      document.querySelector('#playbackHint')?.classList.add('is-hidden');
    } catch {
      document.querySelector('#playbackHint')?.classList.remove('is-hidden');
    }
  }

  destroy() {
    this.player?.destroy?.();
    this.player = null;
    this.iframe = null;
  }
}

function createMediaProvider(media, options) {
  if (media.provider === 'direct_video') return new DirectVideoProvider(media, options);
  if (media.provider === 'youtube' || media.provider === 'vimeo') return new EmbedProvider(media, options);
  throw new Error('This source cannot be played by Zenith. Use a supported direct video URL or authorized embed.');
}

window.ZenithMediaProviders = { createMediaProvider };