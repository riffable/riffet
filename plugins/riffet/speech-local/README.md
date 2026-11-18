Turns what you say into text. Recognition runs on your Riffet server; recordings go nowhere else.

## Getting started

1. Open Settings › Input and, under Voice input, set Recognition to Local speech recognition.
2. Click Local models in the row below and download a model on the Models page that opens. The first download also installs the speech engine (about 10 MB). The page is also under Plugins in the sidebar, in Local speech recognition.
3. In a conversation, click the microphone at the left of the input box and speak. Click ✓ or press Enter to finish, Esc to cancel.

## Which model

| Model | While you speak | Punctuation | Download |
| --- | --- | --- | --- |
| Streaming Zipformer | Text appears as you speak | Commas and full stops at pauses only | 190 MB |
| SenseVoice | Each sentence appears once spoken | Yes, and fewer mistakes | 228 MB |

Both is best: Zipformer shows the words as you speak, and SenseVoice corrects each sentence, with punctuation, once it ends. With only one, pick Zipformer to see text as you speak, or SenseVoice for accuracy.

## Good to know

- In a browser on a phone or another computer, open Riffet over HTTPS; browsers only allow the microphone there.
- Models and the engine are stored on the server, and deleting one frees its space at once. macOS and Linux (x64, arm64) are supported; musl systems such as Alpine are not.
- Models are downloaded from Hugging Face and the engine from npm, and every file is checked after download.
