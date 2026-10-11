#!/usr/bin/env node
import {
  createHash, generateKeyPairSync, verify, createPublicKey,
} from 'node:crypto';
import {
  createReadStream, chmodSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';

const [command, ...args] = process.argv.slice(2);
const options = parseArgs(args);

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith('--')) fail(`Unexpected argument: ${value}`);
    const next = values[i + 1];
    if (!next || next.startsWith('--')) fail(`Missing value for ${value}`);
    parsed[value.slice(2)] = next;
    i += 1;
  }
  return parsed;
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function usage() {
  console.log(`FrameFix private signer and offline verifier (no cloud service)

Commands:
  npm run keys
  npm run signer -- --key-file ./keys/framefix-ed25519-private.pem
  npm run verify -- --file ./edited-image.png --proof ./edited-image.png.framefix-proof.json

The local signer issues exact-file Ed25519 proofs. Verification creates a PDF report locally.`);
}

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

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function keyFingerprint(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `ff-${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

function pdfText(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');
}

function escapePdf(value) {
  return pdfText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function createPdfReport(lines) {
  const wrapped = [];
  for (const line of lines) {
    let remaining = pdfText(line);
    while (remaining.length > 92) {
      let split = remaining.lastIndexOf(' ', 92);
      if (split < 1) split = 92;
      wrapped.push(remaining.slice(0, split));
      remaining = remaining.slice(split).trimStart();
    }
    wrapped.push(remaining);
  }
  const content = ['BT', '/F1 11 Tf', '54 786 Td', '15 TL'];
  wrapped.slice(0, 46).forEach((line, index) => {
    if (index) content.push('T*');
    content.push(`(${escapePdf(line)}) Tj`);
  });
  content.push('ET');
  const stream = Buffer.from(content.join('\n'), 'ascii');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream.toString('ascii')}\nendstream`,
  ];
  const chunks = [Buffer.from('%PDF-1.4\n%FFFX\n', 'ascii')];
  const offsets = [0];
  let cursor = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(cursor);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'ascii');
    chunks.push(chunk);
    cursor += chunk.length;
  });
  const xrefOffset = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'ascii'));
  return Buffer.concat(chunks);
}

if (!command || ['--help', '-h'].includes(command)) {
  usage();
  process.exit(command ? 0 : 1);
}

if (command === 'keys') {
  const outDir = resolve(options.dir || './keys');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const privatePath = resolve(outDir, 'framefix-ed25519-private.pem');
  const publicPath = resolve(outDir, 'framefix-ed25519-public.pem');
  let pair;
  try {
    pair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeFileSync(privatePath, pair.privateKey, { mode: 0o600, flag: 'wx' });
    chmodSync(privatePath, 0o600);
    writeFileSync(publicPath, pair.publicKey, { mode: 0o644, flag: 'wx' });
  } catch (error) {
    fail(`Could not create key files: ${error.message}`);
  }
  const keyId = keyFingerprint(createPublicKey(pair.publicKey));
  console.log(`Created local Ed25519 signing key: ${privatePath}`);
  console.log(`Created trusted verifier public key: ${publicPath}`);
  console.log(`Key ID: ${keyId}`);
  console.log('Keep the private PEM file off GitHub, out of the public site, and backed up securely.');
  process.exit(0);
}

if (command === 'verify') {
  if (!options.file || !options.proof) fail('verify requires --file and --proof.');
  const publicKeyPath = resolve(options['public-key'] || './keys/framefix-ed25519-public.pem');
  let proof;
  try { proof = JSON.parse(readFileSync(resolve(options.proof), 'utf8')); }
  catch (error) { fail(`Cannot read proof JSON: ${error.message}`); }
  if (proof.schema !== 'framefix-local-proof-v2' || proof.claim !== 'framefix_local_signer_signed_export' || proof.signatureAlgorithm !== 'Ed25519') {
    fail('UNVERIFIED: unsupported proof schema, claim, or signing algorithm.');
  }
  if (!Number.isFinite(Date.parse(proof.signedAt)) || !/^[a-f0-9]{64}$/.test(proof.sha256 || '') || typeof proof.proofId !== 'string') {
    fail('UNVERIFIED: proof timestamp or digest is invalid.');
  }
  let publicKey;
  try { publicKey = createPublicKey(readFileSync(publicKeyPath, 'utf8')); }
  catch (error) { fail(`Cannot read trusted public key: ${error.message}`); }
  const expectedKeyId = keyFingerprint(publicKey);
  if (expectedKeyId !== proof.keyId) fail('UNVERIFIED: proof was not signed by the configured trusted key.');

  let actualHash;
  try { actualHash = await hashFile(resolve(options.file)); }
  catch (error) { fail(`Cannot read media file: ${error.message}`); }
  if (actualHash !== proof.sha256) fail('UNVERIFIED: file hash does not match the signed proof. The file changed or the proof belongs to another file.');

  let signature;
  try { signature = Buffer.from(proof.signature, 'base64'); }
  catch { fail('UNVERIFIED: signature is not valid base64.'); }
  if (!verify(null, canonicalPayload(proof), publicKey, signature)) {
    fail('UNVERIFIED: signature is invalid or proof contents were changed.');
  }

  const verifiedAt = new Date().toISOString();
  const reportPath = resolve(options.report || `${resolve(options.file)}.framefix-report.pdf`);
  const report = createPdfReport([
    'FRAMEFIX - LOCAL PROVENANCE VERIFICATION REPORT',
    '',
    'RESULT: VERIFIED',
    `File checked: ${basename(resolve(options.file))}`,
    `SHA-256: ${actualHash}`,
    `Media type: ${proof.mediaType}`,
    `Proof issuer: ${proof.issuer}`,
    `Claim: ${proof.claim}`,
    `Proof signed at (local signer clock): ${proof.signedAt}`,
    `Proof ID: ${proof.proofId}`,
    `Trusted signing key ID: ${expectedKeyId}`,
    `Verification completed locally at: ${verifiedAt}`,
    '',
    'The local signer signed this exact file hash and the proof contents passed Ed25519 verification.',
    'This report does not prove original authorship or independently attest that AI processing occurred.',
    'The timestamp comes from the local computer clock; no external timestamp authority was used.',
    'The media file and proof were checked locally. No verification service was contacted.',
  ]);
  try { writeFileSync(reportPath, report, { flag: 'wx' }); }
  catch (error) { fail(`Verified, but could not write PDF report: ${error.message}`); }
  console.log('VERIFIED');
  console.log(`File: ${basename(resolve(options.file))}`);
  console.log(`SHA-256: ${actualHash}`);
  console.log(`Trusted key: ${expectedKeyId}`);
  console.log(`PDF report: ${reportPath}`);
  process.exit(0);
}

usage();
process.exit(1);
