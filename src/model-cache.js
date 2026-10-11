// Browser-only MI-GAN model cache. The model is fetched once and kept in IndexedDB.
const MODEL_URL = 'https://huggingface.co/lxfater/inpaint-web/resolve/main/migan.onnx';
const DB_NAME = 'framefix-ai';
const STORE = 'models';
const KEY = 'migan-v1';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadModel(onProgress) {
  try {
    const db = await openDb();
    const cached = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (cached?.byteLength > 1_000_000) {
      onProgress?.({ done: cached.byteLength, total: cached.byteLength, cached: true, stage: 'AI model already available on this device' });
      return new Uint8Array(cached);
    }
  } catch { /* IndexedDB may be unavailable; use an in-memory download. */ }

  onProgress?.({ done: 0, total: 0, stage: 'Downloading the AI model (about 29 MB)…' });
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`Could not download the AI model (HTTP ${response.status}). Check your connection and try again.`);
  const total = Number(response.headers.get('content-length')) || 0;
  let bytes;
  if (!response.body) bytes = new Uint8Array(await response.arrayBuffer());
  else {
    const reader = response.body.getReader();
    const chunks = [];
    let done = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      done += part.value.byteLength;
      onProgress?.({ done, total, stage: 'Downloading the AI model…' });
    }
    bytes = new Uint8Array(done);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  }
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(bytes.buffer, KEY);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
  } catch { /* Processing still works for this visit if storage is blocked. */ }
  return bytes;
}
