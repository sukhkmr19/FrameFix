import { init as initInpainter, inpaint, createInpaintProcessor, getBackend } from './inpainter.js';
import { processVideo as recordInpaintedVideo } from './ai-video.js';
import { createFrameFixProof, checkLocalSigner, clearSignerToken, getSignerToken, setSignerToken } from './provenance.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const video = $('#source-video');
const sourceImage = $('#source-image');
const resultVideo = $('#result-video');
const resultImage = $('#result-image');
const stage = $('#video-stage');
const selection = $('#selection');
const selectionSurface = $('#selection-surface');
const fileInput = $('#file-input');
const processButton = $('#process-button');
const drawSelectionButton = $('#draw-selection-button');
const MAX_SIZE = 200 * 1024 * 1024;
const MAX_DURATION = 180;
const MAX_SELECTION_AREA = 0.12;
const MAX_SELECTION_DIMENSION = 0.4;

let currentFile = null;
let mediaMode = 'video';
let sourceURL = null;
let outputURL = null;
let proofURL = null;
let rect = { x: 0, y: 0, w: 0, h: 0 };
let hasSelection = false;
let drawingSelection = false;
let drawStart = null;
let drag = null;
let processing = false;
let toastTimer;

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4200);
}

function paintSelection() {
  const content = getContentRect();
  selection.style.left = `${content.left + rect.x * content.width}px`;
  selection.style.top = `${content.top + rect.y * content.height}px`;
  selection.style.width = `${rect.w * content.width}px`;
  selection.style.height = `${rect.h * content.height}px`;
  $('#area-width').innerHTML = `${Math.round(rect.w * 100)}%<small> width</small>`;
  $('#area-height').innerHTML = `${Math.round(rect.h * 100)}%<small> height</small>`;
  updateButton();
}

function formatEta(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `About ${seconds}s remaining`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `About ${minutes}m ${remainder}s remaining` : `About ${minutes}m remaining`;
}

function setProgress(value, label, details) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  $('#progress-fill').style.width = `${percent}%`;
  $('#progress-value').textContent = `${percent}%`;
  if (label) $('#progress-label').textContent = label;
  const eta = $('#progress-eta');
  eta.textContent = formatEta(details?.etaMs);
  eta.hidden = !eta.textContent;
}

function updateButton() {
  const selectionTooLarge = rect.w * rect.h > MAX_SELECTION_AREA || rect.w > MAX_SELECTION_DIMENSION || rect.h > MAX_SELECTION_DIMENSION;
  const warning = $('#selection-warning');
  warning.hidden = !currentFile || !selectionTooLarge;
  if (currentFile && selectionTooLarge) {
    warning.textContent = `This selection covers ${Math.round(rect.w * 100)}% × ${Math.round(rect.h * 100)}% of the frame. Large masks can invent objects. Resize the box tightly around the logo to continue.`;
  }
  const mediaReady = mediaMode === 'image' ? sourceImage.naturalWidth > 0 : video.videoWidth > 0;
  const ready = currentFile && mediaReady && hasSelection && $('#authorization-check').checked && !processing && !selectionTooLarge && !drawingSelection;
  drawSelectionButton.disabled = !currentFile || !mediaReady || processing;
  drawSelectionButton.textContent = drawingSelection ? 'Cancel area selection' : hasSelection ? 'Redraw selected area' : 'Select area on preview';
  drawSelectionButton.setAttribute('aria-pressed', String(drawingSelection));
  $('#selection-state').textContent = drawingSelection ? 'Drag over the mark' : hasSelection ? 'Area selected' : 'No area selected';
  $('#selection-dot').classList.toggle('is-selected', hasSelection && !drawingSelection);
  $('#area-instruction').textContent = drawingSelection
    ? 'Drag over the mark in your preview.'
    : hasSelection
      ? mediaMode === 'image' ? 'Drag the box to move it, or resize a corner.' : 'Keep the mark inside this box throughout the clip.'
      : currentFile ? 'Select the mark in your preview.' : 'Choose a file to get started.';
  $('#area-width').innerHTML = hasSelection ? `${Math.round(rect.w * 100)}%<small> width</small>` : '—<small> width</small>';
  $('#area-height').innerHTML = hasSelection ? `${Math.round(rect.h * 100)}%<small> height</small>` : '—<small> height</small>';
  processButton.disabled = !ready;
  $('#process-label').textContent = processing ? 'Processing…' : selectionTooLarge && currentFile ? 'Make the area smaller' : !currentFile ? mediaMode === 'image' ? 'Choose an image' : 'Choose a video' : !mediaReady ? 'Loading preview…' : !hasSelection ? 'Select an area first' : !$('#authorization-check').checked ? 'Confirm editing permission' : ready ? 'Remove selected area' : 'Ready when you are';
}

function clearProof() {
  if (proofURL) URL.revokeObjectURL(proofURL);
  proofURL = null;
  $('#proof-download').hidden = true;
  $('#provenance-status').textContent = '';
  $('#provenance-status').hidden = true;
}

async function prepareProof(blob, fileName, mediaType) {
  clearProof();
  $('#provenance-status').hidden = false;
  $('#provenance-status').textContent = 'Signing export on this computer…';
  try {
    const proof = await createFrameFixProof(blob, fileName, mediaType);
    const proofBlob = new Blob([`${JSON.stringify(proof, null, 2)}\n`], { type: 'application/json' });
    proofURL = URL.createObjectURL(proofBlob);
    $('#proof-download').href = proofURL;
    $('#proof-download').download = `${fileName}.framefix-proof.json`;
    $('#proof-download').hidden = false;
    $('#provenance-status').textContent = `Signed on this device · ${new Date(proof.signedAt).toLocaleString()} · separate proof file`;
    return true;
  } catch (error) {
    console.warn('[provenance] Could not create signed export proof:', error);
    $('#provenance-status').textContent = `Signed proof unavailable: ${error.message}`;
    return false;
  }
}

async function connectLocalSigner(token = $('#signer-token').value) {
  const button = $('#connect-signer');
  const status = $('#signer-connection-status');
  button.disabled = true;
  status.textContent = 'Connecting to the private signer on this device…';
  try {
    setSignerToken(token);
    const service = await checkLocalSigner();
    status.textContent = `Connected · key ${service.keyId}`;
    $('#signer-token').value = '';
    $('#signer-token').placeholder = 'Connected for this browser tab';
    showToast('Private local signer connected. Exports will be signed on this device.');
  } catch (error) {
    clearSignerToken();
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

$('#connect-signer').addEventListener('click', () => connectLocalSigner());
$('#signer-token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connectLocalSigner();
});
$('#disconnect-signer').addEventListener('click', () => {
  clearSignerToken();
  $('#signer-connection-status').textContent = 'Disconnected. Your private signing key remains on this device.';
  $('#signer-token').placeholder = 'Paste the one-session pairing code';
});
if (getSignerToken()) {
  checkLocalSigner().then((service) => {
    $('#signer-connection-status').textContent = `Connected · key ${service.keyId}`;
  }).catch((error) => {
    $('#signer-connection-status').textContent = error.message;
    clearSignerToken();
  });
}

function loadVideo(file) {
  if (!file) return;
  const knownVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file.name);
  if (!knownVideo) return showToast('This video format is not supported. Try MP4, MOV, or WebM.');
  if (file.size > MAX_SIZE) return showToast('The file must be under 200 MB. Export a smaller copy and try again.');
  currentFile = file;
  hasSelection = false;
  drawingSelection = false;
  clearProof();
  sourceImage.onload = null;
  sourceImage.onerror = null;
  $('#output-format').textContent = 'MP4 video + audio';
  $('#download-button').hidden = true;
  sourceImage.hidden = true;
  resultImage.hidden = true;
  video.hidden = false;
  $('#result-preview').hidden = true;
  $('#dropzone').hidden = true;
  $('#replace-button').textContent = 'Replace video';
  resultVideo.pause();
  resultVideo.removeAttribute('src');
  resultVideo.load();
  if (outputURL) { URL.revokeObjectURL(outputURL); outputURL = null; }
  fileInput.value = '';
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  sourceURL = URL.createObjectURL(file);
  video.src = sourceURL;
  video.load();
  stage.classList.remove('is-empty');
  $('#empty-preview').hidden = true;
  selection.hidden = false;
  $('#replace-button').hidden = false;
  $('#video-facts').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  rect = { x: 0, y: 0, w: 0, h: 0 };
  selection.hidden = true;
  selectionSurface.hidden = true;
  paintSelection();
  updateButton();
}

function loadImage(file) {
  if (!file) return;
  const supportedImage = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
  if (!supportedImage) return showToast('Choose a JPG, PNG, or WebP image.');
  if (file.size > MAX_SIZE) return showToast('The image must be under 200 MB.');
  currentFile = file;
  hasSelection = false;
  drawingSelection = false;
  clearProof();
  $('#output-format').textContent = 'PNG image';
  $('#download-button').hidden = true;
  sourceImage.onload = null;
  sourceImage.onerror = null;
  sourceImage.removeAttribute('src');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  sourceImage.hidden = false;
  resultVideo.pause();
  resultVideo.removeAttribute('src');
  resultVideo.load();
  resultVideo.hidden = true;
  resultImage.hidden = true;
  $('#result-preview').hidden = true;
  $('#dropzone').hidden = true;
  $('#replace-button').textContent = 'Replace image';
  if (outputURL) { URL.revokeObjectURL(outputURL); outputURL = null; }
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  sourceURL = URL.createObjectURL(file);
  sourceImage.src = sourceURL;
  sourceImage.onload = () => {
    if (sourceImage.naturalWidth * sourceImage.naturalHeight > 16000000) {
      sourceImage.onload = null;
      currentFile = null;
      sourceImage.removeAttribute('src');
      sourceImage.hidden = true;
      stage.classList.add('is-empty');
      $('#empty-preview').hidden = false;
      selection.hidden = true;
      updateButton();
      return showToast('This image is too large for browser editing. Resize it below 16 megapixels and try again.');
    }
    stage.classList.remove('is-empty');
    $('#empty-preview').hidden = true;
    selection.hidden = true;
    selectionSurface.hidden = true;
    $('#replace-button').hidden = false;
    $('#video-facts').textContent = `${file.name} · ${sourceImage.naturalWidth} × ${sourceImage.naturalHeight}`;
    rect = { x: 0, y: 0, w: 0, h: 0 };
    paintSelection();
    updateButton();
  };
  sourceImage.onerror = () => showToast('Could not open this image. Try JPG, PNG, or WebP.');
  fileInput.value = '';
  updateButton();
}

function setMode(nextMode) {
  if (mediaMode === nextMode) return;
  mediaMode = nextMode;
  currentFile = null;
  hasSelection = false;
  drawingSelection = false;
  clearProof();
  video.pause();
  video.removeAttribute('src');
  video.load();
  sourceImage.removeAttribute('src');
  sourceImage.onload = null;
  sourceImage.onerror = null;
  sourceImage.hidden = true;
  video.hidden = nextMode === 'image';
  resultVideo.pause();
  resultVideo.removeAttribute('src');
  resultVideo.load();
  resultVideo.hidden = nextMode === 'image';
  resultImage.removeAttribute('src');
  resultImage.hidden = true;
  $('#result-preview').hidden = true;
  $('#download-button').hidden = true;
  $('#dropzone').hidden = false;
  if (sourceURL) { URL.revokeObjectURL(sourceURL); sourceURL = null; }
  if (outputURL) { URL.revokeObjectURL(outputURL); outputURL = null; }
  stage.classList.add('is-empty');
  $('#empty-preview').hidden = false;
  selection.hidden = true;
  selectionSurface.hidden = true;
  $('#replace-button').hidden = true;
  $('#video-facts').textContent = nextMode === 'image' ? 'No image selected' : 'No video selected';
  $('#video-mode').classList.toggle('active', nextMode === 'video');
  $('#video-mode').setAttribute('aria-selected', String(nextMode === 'video'));
  $('#image-mode').classList.toggle('active', nextMode === 'image');
  $('#image-mode').setAttribute('aria-selected', String(nextMode === 'image'));
  $('#choose-heading').textContent = nextMode === 'image' ? 'Choose an image' : 'Choose a video';
  $('#choose-hint').textContent = nextMode === 'image' ? 'JPG, PNG, or WebP · Up to 200 MB' : 'MP4, MOV, or WebM · Up to 200 MB and 3 minutes';
  $('#drop-title').textContent = nextMode === 'image' ? 'Drop your image here' : 'Drop your video here';
  $('#output-format').textContent = nextMode === 'image' ? 'PNG image' : 'MP4 video + audio';
  $('#tip-copy').textContent = nextMode === 'image'
    ? 'Draw a tight box around the whole mark with a little margin.'
    : 'Keep the mark inside the box for the whole clip. Each frame is repaired separately.';
  $('#honesty-copy').textContent = nextMode === 'image'
    ? 'AI estimates the missing pixels in the selected area; it cannot recover the original hidden image data. Your image stays in this browser.'
    : 'Every frame runs through AI separately, so processing takes longer and results may vary slightly between frames. The selected box stays at the same screen position. The model is cached on your device.';
  fileInput.accept = nextMode === 'image' ? 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp' : 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm';
  rect = { x: 0, y: 0, w: 0, h: 0 };
  hasSelection = false;
  drawingSelection = false;
  selection.hidden = true;
  selectionSurface.hidden = true;
  paintSelection();
  updateButton();
}

video.addEventListener('loadedmetadata', () => {
  if (mediaMode !== 'video') return;
  if (!Number.isFinite(video.duration)) {
    currentFile = null;
    updateButton();
    return showToast('Could not read this video’s duration.');
  }
  if (video.duration > MAX_DURATION) {
    video.pause();
    currentFile = null;
    video.removeAttribute('src');
    video.load();
    stage.classList.add('is-empty');
    $('#empty-preview').hidden = false;
    selection.hidden = true;
    $('#replace-button').hidden = true;
    $('#video-facts').textContent = 'No video selected';
    updateButton();
    return showToast('The video must be shorter than 3 minutes. Export a shorter copy and try again.');
  }
  $('#video-facts').textContent = `${currentFile?.name ?? ''} · ${video.videoWidth} × ${video.videoHeight} · ${formatDuration(video.duration)}`;
  updateButton();
});

video.addEventListener('error', () => {
  if (!currentFile || mediaMode !== 'video') return;
  currentFile = null;
  selection.hidden = true;
  stage.classList.add('is-empty');
  $('#empty-preview').hidden = false;
  $('#replace-button').hidden = true;
  $('#video-facts').textContent = 'Could not preview this video';
  updateButton();
  showToast('Your browser could not preview this video. Try an H.264 MP4 file.');
});

function formatDuration(seconds) {
  const s = Math.floor(seconds || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`;
}

fileInput.addEventListener('change', (event) => mediaMode === 'image' ? loadImage(event.target.files?.[0]) : loadVideo(event.target.files?.[0]));
$('#video-mode').addEventListener('click', () => setMode('video'));
$('#image-mode').addEventListener('click', () => setMode('image'));
$('#replace-button').addEventListener('click', () => fileInput.click());
const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  mediaMode === 'image' ? loadImage(event.dataTransfer.files?.[0]) : loadVideo(event.dataTransfer.files?.[0]);
});

$('#authorization-check').addEventListener('change', updateButton);
drawSelectionButton.addEventListener('click', () => {
  if (!currentFile || processing) return;
  if (drawingSelection) {
    drawingSelection = false;
    selectionSurface.hidden = true;
    selection.hidden = !hasSelection;
  } else {
    drawingSelection = true;
    selection.hidden = true;
    selectionSurface.hidden = false;
  }
  updateButton();
});

function pointerPoint(event) {
  const bounds = stage.getBoundingClientRect();
  const content = getContentRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left - content.left) / content.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top - content.top) / content.height)),
  };
}

function getContentRect() {
  const bounds = stage.getBoundingClientRect();
  const mediaWidth = mediaMode === 'image' ? sourceImage.naturalWidth : video.videoWidth;
  const mediaHeight = mediaMode === 'image' ? sourceImage.naturalHeight : video.videoHeight;
  if (!mediaWidth || !mediaHeight) return { left: 0, top: 0, width: bounds.width, height: bounds.height };
  const scale = Math.min(bounds.width / mediaWidth, bounds.height / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return { left: (bounds.width - width) / 2, top: (bounds.height - height) / 2, width, height };
}

selection.addEventListener('pointerdown', (event) => {
  if (!currentFile || event.button !== 0) return;
  event.preventDefault();
  selection.setPointerCapture(event.pointerId);
  const point = pointerPoint(event);
  const handle = event.target.closest('[data-handle]')?.dataset.handle;
  drag = { handle: handle || 'move', start: point, initial: { ...rect } };
});
selection.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const point = pointerPoint(event);
  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  const original = drag.initial;
  if (drag.handle === 'move') {
    rect.x = Math.max(0, Math.min(1 - original.w, original.x + dx));
    rect.y = Math.max(0, Math.min(1 - original.h, original.y + dy));
  } else {
    const left = drag.handle.includes('w');
    const top = drag.handle.includes('n');
    const rightEdge = original.x + original.w;
    const bottomEdge = original.y + original.h;
    const newLeft = left ? Math.max(0, Math.min(rightEdge - 0.04, original.x + dx)) : original.x;
    const newTop = top ? Math.max(0, Math.min(bottomEdge - 0.04, original.y + dy)) : original.y;
    const newRight = left ? rightEdge : Math.max(original.x + 0.04, Math.min(1, rightEdge + dx));
    const newBottom = top ? bottomEdge : Math.max(original.y + 0.04, Math.min(1, bottomEdge + dy));
    rect = { x: newLeft, y: newTop, w: newRight - newLeft, h: newBottom - newTop };
  }
  paintSelection();
});
selection.addEventListener('pointerup', () => { drag = null; });
selection.addEventListener('pointercancel', () => { drag = null; });

selectionSurface.addEventListener('pointerdown', (event) => {
  if (!drawingSelection || event.button !== 0) return;
  event.preventDefault();
  selectionSurface.setPointerCapture(event.pointerId);
  drawStart = pointerPoint(event);
  hasSelection = false;
  rect = { x: drawStart.x, y: drawStart.y, w: 0, h: 0 };
  selection.hidden = false;
  paintSelection();
});
selectionSurface.addEventListener('pointermove', (event) => {
  if (!drawStart) return;
  const point = pointerPoint(event);
  rect = {
    x: Math.min(drawStart.x, point.x),
    y: Math.min(drawStart.y, point.y),
    w: Math.abs(point.x - drawStart.x),
    h: Math.abs(point.y - drawStart.y),
  };
  paintSelection();
});
function finishAreaSelection() {
  if (!drawStart) return;
  drawStart = null;
  hasSelection = rect.w >= 0.015 && rect.h >= 0.015;
  drawingSelection = false;
  selectionSurface.hidden = true;
  selection.hidden = !hasSelection;
  if (!hasSelection) showToast('Drag farther to draw the selected area.');
  updateButton();
}
selectionSurface.addEventListener('pointerup', finishAreaSelection);
selectionSurface.addEventListener('pointercancel', finishAreaSelection);

async function processVideo() {
  if (!currentFile || !video.videoWidth || !hasSelection || !$('#authorization-check').checked || processing) return;
  processing = true;
  updateButton();
  $('#download-button').hidden = true;
  $('#progress-wrap').hidden = false;
  // Unlock Web Audio synchronously from the user's click for Safari/WebKit,
  // where HTMLMediaElement.captureStream() is unavailable.
  const nativeAudioCapture = video.captureStream || video.mozCaptureStream;
  const audioContext = !nativeAudioCapture && window.AudioContext ? new AudioContext() : null;
  const audioContextReady = audioContext?.resume().catch((error) => {
    console.warn('Could not unlock Web Audio before processing', error);
  });
  try {
    $('#process-label').textContent = 'Loading AI model…';
    await initInpainter((progress) => {
      const pct = progress.total ? 8 + 22 * progress.done / progress.total : 4;
      setProgress(pct, progress.stage || 'Preparing AI model…');
    });
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = video.videoWidth;
    maskCanvas.height = video.videoHeight;
    const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
    const x = Math.round(rect.x * maskCanvas.width);
    const y = Math.round(rect.y * maskCanvas.height);
    const w = Math.max(1, Math.round(rect.w * maskCanvas.width));
    const h = Math.max(1, Math.round(rect.h * maskCanvas.height));
    maskContext.fillStyle = '#fff';
    maskContext.fillRect(x, y, w, h);
    const mask = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const preferredMime = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!preferredMime) throw new Error('Video export is not supported in this browser. Try Chrome or Edge.');
    $('#output-format').textContent = preferredMime.includes('mp4') ? 'MP4 video + audio' : 'WebM video + audio';
    const ext = preferredMime.includes('mp4') ? 'mp4' : 'webm';
    setProgress(29, 'Preparing mask for repeated frame processing…');
    const inpaintFrame = await createInpaintProcessor(mask, { quality: 'standard' });
    const blob = await recordInpaintedVideo({
      video,
      maskImageData: mask,
      inpaintFn: inpaintFrame,
      onProgress: (pct, label, details) => setProgress(30 + pct * 0.7, label, details),
      opts: { includeAudio: true, mimeType: preferredMime, audioContext },
    });
    if (outputURL) URL.revokeObjectURL(outputURL);
    outputURL = URL.createObjectURL(blob);
    resultVideo.src = outputURL;
    resultVideo.hidden = false;
    resultImage.hidden = true;
    resultVideo.load();
    $('#result-preview').hidden = false;
    $('#download-button').href = outputURL;
    const outputName = `${currentFile.name.replace(/\.[^.]+$/, '')}-framefix.${ext}`;
    $('#download-button').download = outputName;
    await prepareProof(blob, outputName, preferredMime.split(';')[0]);
    $('#download-button').textContent = proofURL ? 'Download edited video + proof ↓' : 'Download edited video ↓';
    $('#download-button').hidden = false;
    setProgress(100, `AI complete · ${getBackend().toUpperCase()} · video ready`);
    showToast('AI processing is complete. Review the preview before downloading.');
  } catch (error) {
    console.error('Local video processing failed', error);
    showToast(error.message || 'Processing stopped. Try a shorter or lower-resolution video.');
    $('#progress-wrap').hidden = true;
  } finally {
    await audioContextReady;
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close().catch(() => {});
    }
    processing = false;
    updateButton();
  }
}

async function processImage() {
  if (!currentFile || !sourceImage.naturalWidth || !hasSelection || !$('#authorization-check').checked || processing) return;
  processing = true;
  updateButton();
  $('#download-button').hidden = true;
  $('#progress-wrap').hidden = false;
  try {
    setProgress(3, 'Loading AI model…');
    await initInpainter((progress) => {
      const pct = progress.total ? 5 + 25 * progress.done / progress.total : 4;
      setProgress(pct, progress.stage || 'Preparing AI model…');
    });

    const width = sourceImage.naturalWidth;
    const height = sourceImage.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(sourceImage, 0, 0, width, height);
    const frame = context.getImageData(0, 0, width, height);
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
    maskContext.fillStyle = '#fff';
    maskContext.fillRect(Math.round(rect.x * width), Math.round(rect.y * height), Math.max(1, Math.round(rect.w * width)), Math.max(1, Math.round(rect.h * height)));
    const mask = maskContext.getImageData(0, 0, width, height);

    setProgress(35, 'Removing selected area with AI…');
    const repaired = await inpaint(frame, mask, { quality: 'standard' });
    context.putImageData(repaired, 0, 0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((imageBlob) => imageBlob ? resolve(imageBlob) : reject(new Error('Could not export the edited image.')), 'image/png'));
    if (outputURL) URL.revokeObjectURL(outputURL);
    outputURL = URL.createObjectURL(blob);
    resultVideo.hidden = true;
    resultImage.src = outputURL;
    resultImage.hidden = false;
    $('#result-preview').hidden = false;
    $('#download-button').href = outputURL;
    const outputName = `${currentFile.name.replace(/\.[^.]+$/, '')}-framefix.png`;
    $('#download-button').download = outputName;
    await prepareProof(blob, outputName, 'image/png');
    $('#download-button').textContent = proofURL ? 'Download edited image + proof ↓' : 'Download edited image ↓';
    $('#download-button').hidden = false;
    setProgress(100, 'AI image ready');
    showToast('Image edit is complete. Review it before downloading.');
  } catch (error) {
    console.error('Local image processing failed', error);
    showToast(error.message || 'Image processing failed. Try a smaller image.');
    $('#progress-wrap').hidden = true;
  } finally {
    processing = false;
    updateButton();
  }
}

processButton.addEventListener('click', () => mediaMode === 'image' ? processImage() : processVideo());
$('#download-button').addEventListener('click', () => {
  if (!proofURL) return;
  // Keep the media as the primary download and automatically include its proof sidecar.
  window.setTimeout(() => $('#proof-download').click(), 120);
});
window.addEventListener('resize', paintSelection);
window.addEventListener('beforeunload', () => {
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  if (outputURL) URL.revokeObjectURL(outputURL);
  if (proofURL) URL.revokeObjectURL(proofURL);
  resultVideo.pause();
});

paintSelection();
