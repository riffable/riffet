Adds 翻译 (Translate) to the more menu of each answer; the translation is shown under that answer.

- Choose the language on this page; by default it follows the app's language. An answer already in that language is translated into English instead (into Simplified Chinese when the app is in English).
- It runs on the model chosen for Translation in Settings › Auxiliary models, or on the default model of Settings › Quick chat while none is; the message is sent to that model's provider. With neither, Translate asks you to choose one first.
- Code blocks, inline code, paths, commands and links are left as they are.
- A translation stays only while the conversation is open: it is not written into the conversation or synced to other devices. The server keeps recent translations in memory to answer a repeat at once, and drops them when the plugin is turned off.

This plugin is also the reference for the message menu: one command in the manifest with `menus: ['message']`, a handler that reads `context.message` and answers `{ kind: 'text' }`, and no client code. It is also the reference for model uses (`modelUses`): one declared use, named as `use` in each call. See [Plugin architecture](../../../docs/PLUGIN_ARCHITECTURE.md)「消息菜单」.
