# FrameFix Local Proof Tool

This public utility lets a FrameFix user sign an exported image or video on their own computer, verify it offline, and create a PDF report. It has no cloud signing or verification service.

## What a proof means

The signer hashes the exact exported file and signs a JSON sidecar with the user's local Ed25519 private key and computer clock. The media pixels are not changed. A verifier checks the signature with a public key and confirms the media file still has the signed hash.

A valid proof means **that key signed this exact file hash and proof**. It does not prove that the official FrameFix site performed the edit, that AI processing occurred, who authored the source media, or that the timestamp is externally certified. Anyone can create their own key and sign a file. If a proof is from another person, ask them for the matching public key; trust their identity only if you obtained that key through a channel you trust.

## Requirements

- Node.js 20 or later
- FrameFix open in the same browser where you will connect the local signer

No npm packages need to be installed. The `private: true` field in `package.json` only prevents accidental publication to the npm registry; this source folder is public in the FrameFix Git repository.

## 1. Create your key pair

From this folder, run:

```sh
npm run keys
```

This creates:

- `keys/framefix-ed25519-private.pem` — secret; keep it off GitHub and back it up securely.
- `keys/framefix-ed25519-public.pem` — share this only when someone needs to verify your proof.

The `keys/` directory and key files are ignored by Git. Run key generation once. Keep the private key safe; verification of existing proofs needs the matching public key.

## 2. Sign a FrameFix export

Start the signer from this folder:

```sh
npm run signer -- --key-file ./keys/framefix-ed25519-private.pem
```

The terminal displays a one-session pairing code. In FrameFix, open **Optional: add a verification proof**, enter that code, and connect. Leave the signer running while you process and export. After export, download and keep both the edited media and its `.framefix-proof.json` sidecar. The signer only listens on `127.0.0.1`, hashes the received bytes in memory, and does not save or forward the media. Stop it with Ctrl+C when finished.

## 3. Verify your proof and create a PDF

Keep the media and proof JSON together, then run this from this folder:

```sh
npm run verify -- --file /path/to/edited-image.png --proof /path/to/edited-image.png.framefix-proof.json
```

By default, verification uses `keys/framefix-ed25519-public.pem`. On success, it prints `VERIFIED` and creates `edited-image.png.framefix-report.pdf` next to the media. No network service is contacted.

For video, use the matching `.mp4` or `.webm` file and proof filename.

## Verify someone else's proof

Ask the person to send you all three files: the edited media, its `.framefix-proof.json` sidecar, and the public key they used. Save their public key as a PEM file, then run:

```sh
npm run verify -- --file /path/to/edited-video.mp4 --proof /path/to/edited-video.mp4.framefix-proof.json --public-key /path/to/sender-public-key.pem
```

The PDF says the proof matches that public key. This is not independent evidence that FrameFix generated the media. If you need to know whose key it is, verify the key owner's identity separately.

## Privacy and safe handling

- Media processing stays in the user's browser. The optional signer receives a local loopback copy of the finished export only when connected.
- Never commit or share `framefix-ed25519-private.pem`.
- The public key and proof JSON do not reveal the private key.
- If the media is re-encoded or changed, its hash changes and verification fails.
- A proof sidecar can be deleted; keep it with the media.

