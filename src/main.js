import { init as initInpainter, inpaint, getBackend } from './inpainter.js';
import { processVideo as recordInpaintedVideo } from './ai-video.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const video = $('#source-video');
const resultVideo = $('#result-video');
const stage = $('#video-stage');
const selection = $('#selection');
const fileInput = $('#file-input');
const processButton = $('#process-button');
const MAX_SIZE = 200 * 1024 * 1024;
const MAX_DURATION = 180;
const MAX_SELECTION_AREA = 0.12;
const MAX_SELECTION_DIMENSION = 0.4;

let currentFile = null;
let sourceURL = null;
let outputURL = null;
let rect = { x: 0.68, y: 0.65, w: 0.22, h: 0.2 };
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

function setProgress(value, label) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  $('#progress-fill').style.width = `${percent}%`;
  $('#progress-value').textContent = `${percent}%`;
  if (label) $('#progress-label').textContent = label;
}

function updateButton() {
  const selectionTooLarge = rect.w * rect.h > MAX_SELECTION_AREA || rect.w > MAX_SELECTION_DIMENSION || rect.h > MAX_SELECTION_DIMENSION;
  const warning = $('#selection-warning');
  warning.hidden = !currentFile || !selectionTooLarge;
  if (currentFile && selectionTooLarge) {
    warning.textContent = `This selection covers ${Math.round(rect.w * 100)}% × ${Math.round(rect.h * 100)}% of the frame. Large masks can invent objects. Resize the box tightly around the logo to continue.`;
  }
  const ready = currentFile && video.videoWidth > 0 && $('#authorization-check').checked && !processing && !selectionTooLarge;
  processButton.disabled = !ready;
  $('#process-label').textContent = processing ? 'Processing…' : selectionTooLarge && currentFile ? 'Resize around the logo' : ready ? 'Remove watermark' : currentFile ? 'Loading preview…' : 'Choose a video';
}

function loadVideo(file) {
  if (!file) return;
  const knownVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file.name);
  if (!knownVideo) return showToast('This video format is not supported. Try MP4, MOV, or WebM.');
  if (file.size > MAX_SIZE) return showToast('The file must be under 200 MB. Export a smaller copy and try again.');
  currentFile = file;
  $('#result-preview').hidden = true;
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
  rect = { x: 0.68, y: 0.65, w: 0.22, h: 0.2 };
  paintSelection();
  updateButton();
}

video.addEventListener('loadedmetadata', () => {
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
  if (!currentFile) return;
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

fileInput.addEventListener('change', (event) => loadVideo(event.target.files?.[0]));
$('#replace-button').addEventListener('click', () => fileInput.click());
const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  loadVideo(event.dataTransfer.files?.[0]);
});

$('#authorization-check').addEventListener('change', updateButton);

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
  if (!video.videoWidth || !video.videoHeight) return { left: 0, top: 0, width: bounds.width, height: bounds.height };
  const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
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

async function processVideo() {
  if (!currentFile || !video.videoWidth || !$('#authorization-check').checked || processing) return;
  processing = true;
  updateButton();
  $('#download-button').hidden = true;
  $('#progress-wrap').hidden = false;
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
    const blob = await recordInpaintedVideo({
      video,
      maskImageData: mask,
      inpaintFn: (frame) => inpaint(frame, mask, { quality: 'standard' }),
      onProgress: (pct, label) => setProgress(30 + pct * 0.7, label),
      opts: { includeAudio: true, mimeType: preferredMime },
    });
    if (outputURL) URL.revokeObjectURL(outputURL);
    outputURL = URL.createObjectURL(blob);
    resultVideo.src = outputURL;
    resultVideo.load();
    $('#result-preview').hidden = false;
    $('#download-button').href = outputURL;
    $('#download-button').download = `${currentFile.name.replace(/\.[^.]+$/, '')}-framefix.${ext}`;
    $('#download-button').hidden = false;
    setProgress(100, `AI complete · ${getBackend().toUpperCase()} · video ready`);
    showToast('AI processing is complete. Review the preview before downloading.');
  } catch (error) {
    console.error('Local video processing failed', error);
    showToast(error.message || 'Processing stopped. Try a shorter or lower-resolution video.');
    $('#progress-wrap').hidden = true;
  } finally {
    processing = false;
    updateButton();
  }
}

processButton.addEventListener('click', processVideo);
window.addEventListener('resize', paintSelection);
window.addEventListener('beforeunload', () => {
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  if (outputURL) URL.revokeObjectURL(outputURL);
  resultVideo.pause();
});

paintSelection();
