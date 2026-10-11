# FrameFix

FrameFix is a static GitHub Pages video editor that performs AI inpainting in the browser. It adapts the publicly documented approach used by [WatermarkOut](https://github.com/IamRamgarhia/free-ai-watermark-remover): ONNX Runtime Web runs MI-GAN locally, and a patch reconstructed from the first frame is applied to the video during browser playback. There is no application server and video files are not uploaded.

## What it does

- Upload and preview MP4, MOV, and WebM clips.
- Drag and resize a rectangular selection over the watermark.
- Run MI-GAN image inpainting on the selected area of the first frame.
- Record the video with that reconstructed patch applied and preserve audio when the browser exposes it.
- Cache the ~29 MB model in IndexedDB after its first download.
- Provide an English interface and Terms of Use.
- Deploy as a static site to GitHub Pages.

## Honest limitations

The model runs once on the first frame; the reconstructed patch is reused for the entire clip. This is suited to a stationary watermark over a mostly stationary background. If the background moves, the result can look like a frozen patch or ghosting. This is not full temporal video inpainting. Use short clips and review the exported result.

GitHub Pages serves static files. All inference and recording run on the visitor's device. The first use downloads ONNX Runtime Web from jsDelivr and the model (~29 MB) from Hugging Face; subsequent model use is cached in the browser. Inference speed, video codec support, memory, and audio capture depend on the device and browser. Export is WebM or MP4 according to MediaRecorder support.

Use only videos you own or are authorized to modify. Do not use FrameFix to bypass paid platform branding, DRM, or licensing restrictions.

## Run locally

Requires Node.js 20.19+ (or 22.12+) and npm.

```sh
npm ci
npm run dev
```

The site needs internet access for the ONNX runtime and first-time model download. The video itself stays in the browser.

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

- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) runs the model in the browser.
- [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN), distributed in ONNX format by [lxfater/inpaint-web](https://huggingface.co/lxfater/inpaint-web), reconstructs masked image areas. The model is fetched at runtime rather than committed to this repository.
- `src/inpainter.js` and `src/ai-video.js` adapt code from [WatermarkOut](https://github.com/IamRamgarhia/free-ai-watermark-remover), copyright Prince Ramgarhia, under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

FrameFix code is GNU GPL-2.0-or-later. See [LICENSE](LICENSE).
