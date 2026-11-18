// What the plugin downloads, pinned: a changed file is refused, so the code states exactly what it will run.
// Update by `npm view <package>@<version> dist.integrity` and the Hugging Face tree API (`lfs.oid` is the sha256).

export const ENGINE_VERSION = '1.13.8';

/** `bytes` is the archive's size, for the download's progress before the server answers. */
export interface EnginePackage { name: string; url: string; integrity: string; bytes: number }

const NPM = 'https://registry.npmjs.org';
const pkg = (name: string, integrity: string, bytes: number): EnginePackage => ({ name, url: `${NPM}/${name}/-/${name}-${ENGINE_VERSION}.tgz`, integrity, bytes });

export const ENGINE_NODE: EnginePackage = pkg('sherpa-onnx-node', 'sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==', 11_954);

/** The prebuilt native package of each supported `<os>-<arch>`. */
export const ENGINE_PLATFORMS: Record<string, EnginePackage> = {
  'darwin-arm64': pkg('sherpa-onnx-darwin-arm64', 'sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==', 10_047_754),
  'darwin-x64': pkg('sherpa-onnx-darwin-x64', 'sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==', 11_191_481),
  'linux-x64': pkg('sherpa-onnx-linux-x64', 'sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==', 11_089_653),
  'linux-arm64': pkg('sherpa-onnx-linux-arm64', 'sha512-Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw==', 13_910_679),
};

export interface PinnedFile { name: string; url: string; sha256: string; bytes: number }

export const VAD_FILE: PinnedFile = {
  name: 'silero_vad.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6', bytes: 643_854,
};

export type ModelId = 'zipformer' | 'sensevoice';

export interface ModelPin {
  id: ModelId;
  /** Part of the directory name, so a newer pin downloads beside the old one instead of mixing files. */
  revision: string;
  files: PinnedFile[];
}

const HF = 'https://huggingface.co';
const zipformer = `${HF}/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main`;
const sensevoice = `${HF}/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main`;

export const MODELS: ModelPin[] = [
  {
    id: 'zipformer', revision: '2023-02-20',
    files: [
      { name: 'encoder.int8.onnx', url: `${zipformer}/encoder-epoch-99-avg-1.int8.onnx`, sha256: '8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b', bytes: 181_895_032 },
      // The float decoder: the int8 one is not what sherpa-onnx's own int8 examples pair with the int8 encoder.
      { name: 'decoder.onnx', url: `${zipformer}/decoder-epoch-99-avg-1.onnx`, sha256: '2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d', bytes: 13_876_452 },
      { name: 'joiner.int8.onnx', url: `${zipformer}/joiner-epoch-99-avg-1.int8.onnx`, sha256: '1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0', bytes: 3_228_404 },
      { name: 'tokens.txt', url: `${zipformer}/tokens.txt`, sha256: 'a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3', bytes: 56_317 },
    ],
  },
  {
    // Not the 2025-09-09 repack: it prints no punctuation or digits and ignores inverse text normalization.
    id: 'sensevoice', revision: '2024-07-17',
    files: [
      { name: 'model.int8.onnx', url: `${sensevoice}/model.int8.onnx`, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51', bytes: 239_233_841 },
      { name: 'tokens.txt', url: `${sensevoice}/tokens.txt`, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc', bytes: 315_894 },
    ],
  },
];
