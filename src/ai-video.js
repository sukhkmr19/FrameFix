/**
 * Browser-only video inpainting. Every displayed source frame is inpainted
 * independently; no repaired pixels are reused from a different frame.
 */

export async function loadVideoMetadata(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  // Keep the source's audio track enabled for later capture. Frame scanning
  // mutes playback temporarily and restores this state before export.
  video.muted = false;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Could not decode video')), { once: true });
  });

  return {
    video,
    url,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
    revoke: () => URL.revokeObjectURL(url),
  };
}

function findMaskBounds(mask) {
  let left = mask.width;
  let top = mask.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[(y * mask.width + x) * 4 + 3] <= 16) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error('Select the watermark area first.');
  const feather = 8;
  const x = Math.max(0, left - feather);
  const y = Math.max(0, top - feather);
  const r = Math.min(mask.width, right + feather + 1);
  const b = Math.min(mask.height, bottom + feather + 1);
  return { x, y, width: r - x, height: b - y };
}

function seekTo(video, time) {
  if (Math.abs(video.currentTime - time) < 0.0005 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out while decoding a video frame.')), 10000);
    const finish = (error) => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      error ? reject(error) : resolve();
    };
    const onSeeked = () => finish();
    const onError = () => finish(new Error('Could not decode a video frame.'));
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = time;
  });
}

async function collectFrameTimes(video, duration, onProgress) {
  await seekTo(video, 0);
  const originalMuted = video.muted;
  video.muted = true;
  if (typeof video.requestVideoFrameCallback !== 'function') {
    // Legacy-browser fallback. Modern Chrome, Firefox, and Safari use the
    // decoder's actual per-frame media timestamps below.
    const times = [];
    for (let t = 0; t < duration; t += 1 / 30) {
      times.push(t);
      if (times.length % 30 === 0) onProgress?.(t, times.length);
    }
    video.muted = originalMuted;
    return times;
  }

  const times = [0];
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.pause();
      video.muted = originalMuted;
      error ? reject(error) : resolve(times);
    };
    const onEnded = () => finish();
    const onError = () => finish(new Error('Video playback failed while reading its frames.'));
    const safetyTimer = setTimeout(() => finish(new Error('Timed out while reading video frames.')), (duration + 10) * 2 * 1000);
    video.addEventListener('ended', onEnded, { once: true });
    video.addEventListener('error', onError, { once: true });

    const readFrame = (_now, metadata) => {
      const time = metadata.mediaTime;
      if (Number.isFinite(time) && time > times[times.length - 1] + 0.0001 && time < duration) {
        times.push(time);
        onProgress?.(time, times.length);
      }
      if (!settled && !video.ended) video.requestVideoFrameCallback(readFrame);
    };
    video.requestVideoFrameCallback(readFrame);
    video.play().catch((error) => finish(new Error(`Could not read video frames: ${error.message || error}`)));
  });
}

async function makePatchBlob(inpainted, mask, bounds) {
  const base = document.createElement('canvas');
  base.width = bounds.width;
  base.height = bounds.height;
  const context = base.getContext('2d');
  const patch = context.createImageData(bounds.width, bounds.height);
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const sourceIndex = ((bounds.y + y) * mask.width + bounds.x + x) * 4;
      const targetIndex = (y * bounds.width + x) * 4;
      if (mask.data[sourceIndex + 3] > 16) {
        patch.data[targetIndex] = inpainted.data[sourceIndex];
        patch.data[targetIndex + 1] = inpainted.data[sourceIndex + 1];
        patch.data[targetIndex + 2] = inpainted.data[sourceIndex + 2];
        patch.data[targetIndex + 3] = 255;
      }
    }
  }
  context.putImageData(patch, 0, 0);

  const softened = document.createElement('canvas');
  softened.width = bounds.width;
  softened.height = bounds.height;
  const softContext = softened.getContext('2d');
  softContext.filter = 'blur(6px)';
  softContext.drawImage(base, 0, 0);
  softContext.filter = 'none';

  return new Promise((resolve, reject) => {
    softened.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not prepare an inpainted frame.')), 'image/webp', 0.96);
  });
}

async function decodePatchBlobs(blobs, onProgress, exportDurationMs) {
  const bitmaps = [];
  const startedAt = performance.now();
  try {
    for (let i = 0; i < blobs.length; i++) {
      bitmaps.push(await createImageBitmap(blobs[i]));
      if (i % 12 === 0 || i === blobs.length - 1) {
        const completed = i + 1;
        const averageMs = (performance.now() - startedAt) / completed;
        const etaMs = averageMs * (blobs.length - completed) + exportDurationMs;
        onProgress?.(82 + (i / Math.max(1, blobs.length)) * 14, `Preparing repaired frames ${completed}/${blobs.length}`, { etaMs });
      }
    }
    return bitmaps;
  } catch (error) {
    bitmaps.forEach((bitmap) => bitmap.close?.());
    throw error;
  }
}

/** Process and export a video, returning a local Blob. */
export async function processVideo({ video, maskImageData, inpaintFn, onProgress, opts = {} }) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const duration = video.duration;
  const startedAt = performance.now();
  const bounds = findMaskBounds(maskImageData);
  let patchBitmaps = [];

  const originalMuted = video.muted;
  const originalVolume = video.volume;
  onProgress?.(2, 'Reading every source frame');
  const frameTimes = await collectFrameTimes(video, duration, (time, count) => {
    const etaMs = Math.max(0, duration - time) * 1000;
    onProgress?.(1 + (time / duration) * 4, `Reading source frames · ${count}`, { etaMs });
  });
  if (!frameTimes.length) throw new Error('No video frames were found.');

  // Limit decoded patch memory to 256 MiB so long clips or large selections
  // fail clearly instead of exhausting the browser tab.
  const decodedPatchBytes = bounds.width * bounds.height * 4 * frameTimes.length;
  if (decodedPatchBytes > 256 * 1024 * 1024) {
    throw new Error('This clip is too long for the selected area to process safely in this browser. Use a shorter clip or a tighter selection.');
  }

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = width;
  frameCanvas.height = height;
  const frameContext = frameCanvas.getContext('2d', { willReadFrequently: true });
  const patchBlobs = [];
  const frameProcessingStartedAt = performance.now();
  for (let i = 0; i < frameTimes.length; i++) {
    await seekTo(video, frameTimes[i]);
    frameContext.drawImage(video, 0, 0, width, height);
    const frame = frameContext.getImageData(0, 0, width, height);
    const repaired = await inpaintFn(frame, maskImageData);
    patchBlobs.push(await makePatchBlob(repaired, maskImageData, bounds));
    if (i % 2 === 0 || i === frameTimes.length - 1) {
      const completed = i + 1;
      const averageMs = (performance.now() - frameProcessingStartedAt) / completed;
      const etaMs = averageMs * (frameTimes.length - completed) + duration * 1000;
      onProgress?.(5 + (i / Math.max(1, frameTimes.length)) * 76, `Removing watermark frame by frame · ${completed}/${frameTimes.length}`, { etaMs });
    }
  }
  patchBitmaps = await decodePatchBlobs(patchBlobs, onProgress, duration * 1000);
  video.pause();
  await seekTo(video, 0);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outContext = outCanvas.getContext('2d');
  const canvasStream = outCanvas.captureStream();
  const videoTrack = canvasStream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('This browser could not capture the edited video.');

  let audioTrack = null;
  if (opts.includeAudio !== false) {
    try {
      video.muted = false;
      const sourceStream = video.captureStream ? video.captureStream() : video.mozCaptureStream?.();
      audioTrack = sourceStream?.getAudioTracks()[0] || null;
    } catch (error) {
      console.warn('[video] Native audio capture unavailable:', error);
    }
    if (!audioTrack && opts.audioContext) {
      try {
        const audioSource = opts.audioContext.createMediaElementSource(video);
        const destination = opts.audioContext.createMediaStreamDestination();
        audioSource.connect(destination);
        audioTrack = destination.stream.getAudioTracks()[0] || null;
      } catch (error) {
        console.warn('[video] Web Audio capture unavailable:', error);
      }
    }
  }

  const outputStream = new MediaStream([videoTrack, ...(audioTrack ? [audioTrack] : [])]);
  const candidates = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mimeType = opts.mimeType || candidates.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('No supported video export format was found.');
  const recorder = new MediaRecorder(outputStream, { mimeType, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  let lastExportProgressAt = -1;

  const drawFrame = (index) => {
    outContext.drawImage(video, 0, 0, width, height);
    const bitmap = patchBitmaps[index];
    if (bitmap) outContext.drawImage(bitmap, bounds.x, bounds.y);
  };
  drawFrame(0);
  // Zero element volume avoids autoplay blocking after the long AI pass while
  // captureStream continues to carry the original audio samples.
  video.volume = 0;
  recorder.start();
  onProgress?.(96, 'Exporting repaired video with original audio', { etaMs: duration * 1000 });

  const frameIndexAt = (time) => {
    let index = 0;
    while (index + 1 < frameTimes.length && frameTimes[index + 1] <= time + 0.0005) index++;
    return index;
  };
  try {
    await new Promise((resolve, reject) => {
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        video.removeEventListener('ended', onEnded);
        video.removeEventListener('error', onError);
        error ? reject(error) : resolve();
      };
      const onEnded = () => finish();
      const onError = () => finish(new Error('Video playback failed during export.'));
      timer = setTimeout(() => finish(new Error('Video export timed out.')), (duration + 10) * 2000);
      video.addEventListener('ended', onEnded, { once: true });
      video.addEventListener('error', onError, { once: true });

      if (typeof video.requestVideoFrameCallback === 'function') {
        const render = (_now, metadata) => {
          drawFrame(frameIndexAt(metadata.mediaTime));
          if (metadata.mediaTime - lastExportProgressAt >= 0.25 || metadata.mediaTime >= duration) {
            lastExportProgressAt = metadata.mediaTime;
            onProgress?.(96 + (metadata.mediaTime / duration) * 4, 'Exporting repaired video with original audio', { etaMs: Math.max(0, duration - metadata.mediaTime) * 1000 });
          }
          if (!video.ended) video.requestVideoFrameCallback(render);
        };
        video.requestVideoFrameCallback(render);
      } else {
        const render = () => {
          drawFrame(frameIndexAt(video.currentTime));
          if (video.currentTime - lastExportProgressAt >= 0.25 || video.currentTime >= duration) {
            lastExportProgressAt = video.currentTime;
            onProgress?.(96 + (video.currentTime / duration) * 4, 'Exporting repaired video with original audio', { etaMs: Math.max(0, duration - video.currentTime) * 1000 });
          }
          if (!video.ended) requestAnimationFrame(render);
        };
        requestAnimationFrame(render);
      }
      video.play().catch((error) => finish(new Error(`Could not export video: ${error.message || error}`)));
    });
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    video.pause();
    video.muted = originalMuted;
    video.volume = originalVolume;
    patchBitmaps.forEach((bitmap) => bitmap.close?.());
  }

  onProgress?.(100, `Done in ${((performance.now() - startedAt) / 1000).toFixed(1)}s · ${frameTimes.length} frames repaired`, { etaMs: 0 });
  return new Blob(chunks, { type: mimeType });
}
