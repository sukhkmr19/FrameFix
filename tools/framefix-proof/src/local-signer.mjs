#!/usr/bin/env node
import { createHash, createPrivateKey, randomBytes, createPublicKey, sign, timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 1) {
  const name = args[index];
  if (!name.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--')) {
    console.error('Usage: npm run signer -- --key-file ./keys/framefix-ed25519-private.pem');
    process.exit(2);
  }
  options[name.slice(2)] = args[++index];
}
if (!options['key-file']) {
  console.error('Missing --key-file. Generate a key pair with `npm run keys` first.');
  process.exit(2);
}

const allowedOrigins = new Set([
  'https://sukhkmr19.github.io',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);
const maxBytes = 220 * 1024 * 1024;
const port = Number(options.port || 8788);
const privateKey = createPrivateKey(readFileSync(resolve(options['key-file']), 'utf8'));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Signing key must be Ed25519.');
const publicKey = createPublicKey(privateKey);
const publicDer = publicKey.export({ type: 'spki', format: 'der' });
const keyId = `ff-${createHash('sha256').update(publicDer).digest('hex').slice(0, 16)}`;
const pairingCode = randomBytes(24).toString('base64url');

function canonicalPayload(proof) {
  return Buffer.from(JSON.stringify({
    schema: proof.schema,
    keyId: proof.keyId,
    issuer: proof.issuer,
    claim: proof.claim,
    signedAt: proof.signedAt,
    fileName: proof.fileName,
    mediaType: proof.mediaType,
    sha256: proof.sha256,
    proofId: proof.proofId,
  }), 'utf8');
}

function sendJson(res, status, body, origin = '') {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
  if (origin && allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-FrameFix-Filename, X-FrameFix-Media-Type';
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function isAuthorized(req) {
  const value = req.headers.authorization || '';
  const supplied = value.startsWith('Bearer ') ? value.slice(7) : '';
  const left = Buffer.from(supplied);
  const right = Buffer.from(pairingCode);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

async function digestRequest(req) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Export is larger than the 220 MB local signing limit.'), { statusCode: 413 });
    hash.update(chunk);
  }
  if (!size) throw Object.assign(new Error('The export is empty.'), { statusCode: 400 });
  return hash.digest('hex');
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (!allowedOrigins.has(origin)) return sendJson(res, 403, { error: 'This FrameFix origin is not allowed.' }, origin);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {}, origin);
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Pairing code is incorrect or expired.' }, origin);
  if (req.method === 'GET' && url.pathname === '/v1/health') {
    return sendJson(res, 200, { service: 'FrameFix Local Signer', keyId }, origin);
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/sign') {
    return sendJson(res, 404, { error: 'Not found.' }, origin);
  }
  const mediaType = String(req.headers['x-framefix-media-type'] || '').toLowerCase();
  if (!['image/png', 'video/mp4', 'video/webm'].includes(mediaType)) {
    req.resume();
    return sendJson(res, 415, { error: 'Only PNG, MP4, and WebM exports can be signed.' }, origin);
  }
  if (!String(req.headers['content-type'] || '').startsWith('application/octet-stream')) {
    req.resume();
    return sendJson(res, 415, { error: 'Expected the completed export as an octet stream.' }, origin);
  }
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > maxBytes) {
    req.resume();
    return sendJson(res, 413, { error: 'Export is larger than the 220 MB local signing limit.' }, origin);
  }
  try {
    const fileName = decodeURIComponent(String(req.headers['x-framefix-filename'] || 'export'))
      .normalize('NFKC').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 160);
    const sha256 = await digestRequest(req);
    const proof = {
      schema: 'framefix-local-proof-v2',
      keyId,
      issuer: 'Sukhbeer · FrameFix',
      claim: 'framefix_local_signer_signed_export',
      signedAt: new Date().toISOString(),
      fileName: basename(fileName) || 'export',
      mediaType,
      sha256,
      proofId: randomBytes(16).toString('hex'),
      signatureAlgorithm: 'Ed25519',
    };
    proof.signature = sign(null, canonicalPayload(proof), privateKey).toString('base64');
    return sendJson(res, 200, { proof }, origin);
  } catch (error) {
    if (!req.destroyed) req.resume();
    return sendJson(res, error.statusCode || 400, { error: error.message || 'Could not sign export.' }, origin);
  }
});

server.requestTimeout = 180_000;
server.headersTimeout = 30_000;
server.listen(port, '127.0.0.1', () => {
  console.log('FrameFix private local signer is running on this computer only.');
  console.log(`Address: http://127.0.0.1:${port}`);
  console.log(`Trusted key: ${keyId}`);
  console.log(`One-session pairing code: ${pairingCode}`);
  console.log('Paste the pairing code into FrameFix in the same browser tab. Keep this terminal private.');
  console.log('Stop the signer with Ctrl+C when finished.');
});
