# Third-party references and runtime components

The Weixin HTTP client and media handling are implemented in this project using the public Tencent iLink protocol as reference. No upstream transport source files are vendored.

- Tencent/openclaw-weixin, MIT, Copyright (C) 2026 Tencent. Protocol, media wire fields and CDN interoperability reference. https://github.com/Tencent/openclaw-weixin
- panqing0313/dsh-plugin-weixin, MIT, Copyright (c) 2026 dsh-weixin contributors. Design reference for inbound media, safe outbound paths, attachment extraction, video frames, SILK encoding and audio-file fallback. Its source records cases where accepted native voice bubbles were not delivered. https://github.com/panqing0313/dsh-plugin-weixin
- silk-wasm 3.7.1, MIT. SILK codec and embedded upstream codec notices remain in the npm package. https://github.com/idranme/silk-wasm
- Transformers.js 3.8.1, Apache-2.0, and ONNX Runtime, MIT. Local speech inference. https://github.com/huggingface/transformers.js
- Xenova/whisper-tiny, Apache-2.0 model metadata. Downloaded separately into the user's private model cache. https://huggingface.co/Xenova/whisper-tiny
- marked 15.0.12, MIT. Markdown parsing, excluding code blocks from attachment discovery. https://github.com/markedjs/marked
- sharp 0.34.5, Apache-2.0, and its bundled libvips notices. Image format checks. https://github.com/lovell/sharp
- @ffmpeg-installer/ffmpeg 1.1.0 and its platform packages supplies FFmpeg built with GPL components. This project installs the npm package locally. Any future redistribution of the binary must comply with the exact FFmpeg build's GPL/source obligations. https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg

The project's MIT license covers its own source. Runtime component licenses remain applicable. The Codex client originates in Ace's MIT-licensed codex-wecom project.
