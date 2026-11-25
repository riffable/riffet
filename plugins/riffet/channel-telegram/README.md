Talk to Riffet conversations from Telegram private chats or groups. Riffet streams thinking, tool calls and answers directly into Telegram, supports inline buttons for approvals, questions and model switching, and keeps conversations synced with other clients.

## Before you start

- Create a bot with `@BotFather` (`/newbot`) and copy its Bot Token.
- The server connects outbound to `api.telegram.org` via long polling (no public URL or webhook needed). If the server cannot reach Telegram directly, configure an HTTP/HTTPS proxy or custom Bot API base URL in Settings › Bots.
- Only one Riffet instance should poll the same Bot Token; a second instance causes Telegram `409 Conflict` errors.
- Optional: enable **Threaded Mode** in `@BotFather` to give each private-chat topic its own conversation.

## Configuration

- Settings › Bots lets you add a Telegram bot with its Bot Token, view connection status, and configure what appears in replies (header, process, stop button, footer).
- Only bound Telegram users can talk to the bot; everyone else is ignored. Generate a 5-minute pairing code in Settings › Bots and send `/bind <code>` to the bot in a private chat.
- Commands registered in Telegram's `/` menu: `/new`, `/stop`, `/status`, `/model`, `/project`, `/help` (plus `/flat on|off` in groups and `/bind <code>`).

## Groups and conversations

- In a group, mention `@your_bot` or reply to a bot message to start a conversation. In Forum groups, each topic is its own conversation; in regular groups, each reply chain is a conversation. `/flat on` makes the whole group share one conversation.
- To let bound users continue a bound topic without mentioning the bot on every message, disable Group Privacy in `@BotFather` (`/setprivacy` → Disable).
- Each chat binds to one project (chosen on first use, changed with `/project`).

## Data

The Bot Token is stored on the server in a private file (`0600`) and is never sent to clients; settings only show whether it is set. Images and files you send are downloaded by the server (up to Telegram's 20 MB Bot API file limit) and attached to the conversation.
