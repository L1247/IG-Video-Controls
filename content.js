/**
 * IG Video Progressbar
 * Injects a YouTube-style seekable progress bar onto Instagram videos.
 */

(function () {
  'use strict';

  // Avoid double injection
  if (window.__igpbLoaded) return;
  window.__igpbLoaded = true;

  const ATTR = 'data-igpb';

  // ── Helpers ──────────────────────────────────────────────────────────────

  function formatTime(seconds) {
    if (!isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
  }

  // ── Build the progress bar DOM ───────────────────────────────────────────

  function buildProgressBar(video) {
    // gradient fade (visual only, pointer-events: none)
    const gradient = document.createElement('div');
    gradient.className = 'igpb-gradient';

    // track (clickable area)
    const track = document.createElement('div');
    track.className = 'igpb-bar-track';

    const buffered = document.createElement('div');
    buffered.className = 'igpb-buffered';

    const progress = document.createElement('div');
    progress.className = 'igpb-progress';

    const thumb = document.createElement('div');
    thumb.className = 'igpb-thumb';

    const tooltip = document.createElement('div');
    tooltip.className = 'igpb-tooltip';
    tooltip.textContent = '0:00';

    track.appendChild(buffered);
    track.appendChild(progress);
    track.appendChild(thumb);
    track.appendChild(tooltip);

    const container = document.createElement('div');
    container.className = 'igpb-container';
    container.appendChild(track);

    return { container, track, buffered, progress, thumb, tooltip, gradient };
  }

  // ── Attach to a single video element ────────────────────────────────────

  function attachProgressBar(video) {
    if (video.hasAttribute(ATTR)) return;
    video.setAttribute(ATTR, '1');

    // We need a positioned parent. Wrap video if parent isn't positioned.
    const parent = video.parentElement;
    if (!parent) return;

    const { container, track, buffered, progress, thumb, tooltip, gradient } =
      buildProgressBar(video);

    // Insert gradient + bar into the same positioned ancestor
    const existingPosition = getComputedStyle(parent).position;
    if (existingPosition === 'static') {
      parent.style.position = 'relative';
    }

    parent.appendChild(gradient);
    parent.appendChild(container);

    // ── Update UI from video state ─────────────────────────────────────

    function updateProgress() {
      const duration = video.duration;
      if (!duration || !isFinite(duration)) return;

      const pct = (video.currentTime / duration) * 100;
      progress.style.width = `${pct}%`;
      thumb.style.left = `${pct}%`;

      // buffered
      if (video.buffered.length > 0) {
        const bufPct =
          (video.buffered.end(video.buffered.length - 1) / duration) * 100;
        buffered.style.width = `${bufPct}%`;
      }
    }

    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('progress', updateProgress);
    video.addEventListener('loadedmetadata', updateProgress);

    // ── Seek logic ────────────────────────────────────────────────────

    function getSeekFraction(clientX) {
      const rect = track.getBoundingClientRect();
      return clamp((clientX - rect.left) / rect.width, 0, 1);
    }

    function seekTo(fraction) {
      const duration = video.duration;
      if (!duration || !isFinite(duration)) return;
      video.currentTime = fraction * duration;

      // Update thumb + progress immediately (don't wait for timeupdate)
      const pct = fraction * 100;
      progress.style.width = `${pct}%`;
      thumb.style.left = `${pct}%`;
      tooltip.textContent = formatTime(fraction * duration);
      tooltip.style.left = `${pct}%`;
    }

    function updateTooltip(fraction) {
      const duration = video.duration;
      if (!duration || !isFinite(duration)) return;
      const time = fraction * duration;
      tooltip.textContent = formatTime(time);
      tooltip.style.left = `${clamp(fraction * 100, 0, 100)}%`;
    }

    // Mouse events on the container (the full 24px hit area)
    let dragging = false;

    container.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      container.classList.add('igpb-dragging');

      const fraction = getSeekFraction(e.clientX);
      seekTo(fraction);

      // Pause while scrubbing (optional — matches YouTube behaviour)
      // video.pause();
    });

    container.addEventListener('mousemove', (e) => {
      const fraction = getSeekFraction(e.clientX);
      updateTooltip(fraction);
      if (dragging) {
        seekTo(fraction);
      }
    });

    container.addEventListener('mouseleave', () => {
      if (!dragging) {
        // Reset tooltip position to current time on leave
        const duration = video.duration;
        if (duration && isFinite(duration)) {
          tooltip.textContent = formatTime(video.currentTime);
        }
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (dragging) {
        e.preventDefault();
        const fraction = getSeekFraction(e.clientX);
        seekTo(fraction);
      }
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        container.classList.remove('igpb-dragging');
        // video.play();  // Resume if we paused during scrub
      }
    });

    // Touch support
    container.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      container.classList.add('igpb-dragging');
      const fraction = getSeekFraction(e.touches[0].clientX);
      seekTo(fraction);
    }, { passive: false });

    container.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (dragging) {
        const fraction = getSeekFraction(e.touches[0].clientX);
        seekTo(fraction);
        updateTooltip(fraction);
      }
    }, { passive: false });

    container.addEventListener('touchend', () => {
      dragging = false;
      container.classList.remove('igpb-dragging');
    });

    // Prevent clicks on the bar from triggering IG's own play/pause
    container.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // ── Scan page for videos ─────────────────────────────────────────────────

  function scanVideos() {
    document.querySelectorAll('video').forEach((video) => {
      // Only attach to videos that have a duration (i.e., not live/story previews that are too short)
      // We attach regardless and let the bar be a no-op on 0-duration videos
      attachProgressBar(video);
    });
  }

  // ── MutationObserver: watch for dynamically added videos ─────────────────

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'VIDEO') {
          attachProgressBar(node);
        } else {
          node.querySelectorAll?.('video').forEach(attachProgressBar);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial scan
  scanVideos();

  // Re-scan on navigation (Instagram is a SPA)
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(scanVideos, 800);
    }
  }, 500);
})();
