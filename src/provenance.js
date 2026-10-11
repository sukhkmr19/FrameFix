const SIGNER_URL = 'http://127.0.0.1:8788';
const TOKEN_KEY = 'framefix-local-signer-token';

export function getSignerToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; }
  catch { return ''; }
}

export function setSignerToken(token) {
  const normalized = token.trim();
  if (!normalized) throw new Error('Enter the pairing code printed by the private signer.');
  try { sessionStorage.setItem(TOKEN_KEY, normalized); }
  catch { throw new Error('This browser could not keep the pairing code for this tab.'); }
}

export function clearSignerToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* private browsing may disable storage */ }
}

export async function checkLocalSigner(token = getSignerToken()) {
  if (!token) throw new Error('Start the private signer and enter its pairing code.');
  let response;
  try {
    response = await fetch(`${SIGNER_URL}/v1/health`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch {
    throw new Error('Could not reach the local signer. Start it and allow the browser local-network prompt if shown.');
  }
  if (!response.ok) throw new Error('Pairing code was rejected or the private signer is unavailable.');
  const body = await response.json();
  if (body?.service !== 'FrameFix Local Signer') throw new Error('Unexpected response from the local signer.');
  return body;
}

export async function createFrameFixProof(blob, fileName, mediaType) {
  const token = getSignerToken();
  if (!token) throw new Error('Connect the private local signer before exporting to create a proof.');
  let response;
  try {
    response = await fetch(`${SIGNER_URL}/v1/sign`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'X-FrameFix-Filename': encodeURIComponent(fileName),
        'X-FrameFix-Media-Type': mediaType,
      },
      body: blob,
      cache: 'no-store',
    });
  } catch {
    throw new Error('Could not reach the private local signer. Keep it running and try again.');
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error('The local signer returned an unreadable response.'); }
  if (!response.ok) throw new Error(payload?.error || `The local signer returned HTTP ${response.status}.`);
  if (payload?.proof?.schema !== 'framefix-local-proof-v2' || payload.proof.signatureAlgorithm !== 'Ed25519') {
    throw new Error('The local signer returned an unsupported proof format.');
  }
  return payload.proof;
}
