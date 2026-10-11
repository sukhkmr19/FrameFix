# FrameFix

FrameFix is a GitHub Pages editor that performs AI inpainting in the browser. ONNX Runtime Web runs MI-GAN locally, and the selected region is reconstructed independently for every decoded video frame. Media files are not uploaded to a remote service. Optional export signing uses a separate private local helper on the same computer.

## What it does

- Upload and preview MP4, MOV, and WebM clips.
- Upload JPG, PNG, or WebP images for single-image inpainting and PNG export.
- Drag and resize a rectangular selection over the watermark.
- Run MI-GAN image inpainting on the selected area of every frame.
- Export the repaired frames with the source playback timing and audio track.
- Cache the ~29 MB model in IndexedDB after its first download.
- Provide an English interface and Terms of Use.
- Deploy as a static site to GitHub Pages.

## Honest limitations

The model runs separately for each decoded frame, so processing takes longer than one-pass image repair and results can vary slightly between frames. The selection stays at one screen position; the watermark must remain inside the selected box throughout the clip. Browser memory limits may require a shorter clip or smaller selection. Review the exported result.

GitHub Pages serves static files. All inference and recording run on the visitor's device. ONNX Runtime Web and its WASM files are bundled with the site; the AI model (~29 MB) downloads from Hugging Face once and is then cached in the browser. The model host provides the model file only; FrameFix does not send media to it. Inference speed, video codec support, memory, and audio capture depend on the device and browser. Export is WebM or MP4 according to MediaRecorder support.

## Optional local export proof

FrameFix includes an optional public, offline-capable proof tool in [`tools/framefix-proof`](tools/framefix-proof/). Each person can generate their own Ed25519 key, run a signer on their own computer, and connect it to FrameFix. After export, the browser downloads the unchanged media plus a `.framefix-proof.json` sidecar. The signer receives the finished bytes over loopback (`127.0.0.1`) on that same computer; it does not upload them to a remote signing service.

The proof tool can verify the media and sidecar offline and create a PDF report. Verification proves that the selected public key signed the exact file hash and proof contents. It does **not** prove the file was created by the official FrameFix site, that AI processing occurred, or who authored the original media. A visitor's proof is signed by that visitor's own key; to verify it, request the media, sidecar, and matching public key. The timestamp comes from the signer's local clock, not an external timestamp authority. See [`tools/framefix-proof/README.md`](tools/framefix-proof/README.md) for setup and exact commands.

Keep each private key secret and out of Git. The public key may be shared alongside a proof. Trust the public key through a separate channel if the identity of its owner matters.

Use only videos you own or are authorized to modify. Do not use FrameFix to bypass paid platform branding, DRM, or licensing restrictions.

## Run locally

Requires Node.js 20.19+ (or 22.12+) and npm.

```sh
npm ci
npm run dev
```

The site needs internet access to load GitHub Pages and download the AI model on first use. Media stays in the browser except for a local loopback transfer to the optional signer on the same computer.

```sh
npm run build
npm run preview
```

## Deploy to GitHub Pages

1. Push this repository to GitHub on the `main` branch.
2. Open **Settings → Pages** and choose **GitHub Actions** as the source.
3. The included workflow builds and publishes `dist/` after each push to `main`.
4. Open the Pages URL shown in the workflow deployment summary.

Vite configures the Pages subpath through the repository name supplied by GitHub Actions.

## Third-party components

- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) runs locally in the browser; its JS and WebAssembly assets are bundled with this site under the MIT license.
- [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN), distributed in ONNX format by [lxfater/inpaint-web](https://huggingface.co/lxfater/inpaint-web), reconstructs masked image areas. The model is fetched at runtime rather than committed to this repository.
- `src/inpainter.js` and `src/ai-video.js` adapt code from [WatermarkOut](https://github.com/IamRamgarhia/free-ai-watermark-remover), copyright Prince Ramgarhia, under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

FrameFix code is GNU GPL-2.0-or-later. See [LICENSE](LICENSE).
