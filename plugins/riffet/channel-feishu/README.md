Talk to Riffet conversations from Feishu or Lark. Message the bot in a private chat or a group; Riffet starts or continues a conversation in the project chosen for that chat and writes thinking, tool calls and the answer back to a card. Approvals and questions can be answered in Feishu, and a conversation started there stays in sync with the other clients.

## Before you start

- The server must be able to connect out to Feishu or Lark. No public address is needed.
- Create the bot by scanning a code with the Feishu or Lark app. Riffet receives the App ID and App Secret and binds the person who scanned. You can also enter the App ID and App Secret of an existing app.
- Only one Riffet instance can connect per app. A second connection makes Feishu split events between them and messages go missing.

## Configuration

- Settings › Bots lists the bots, their connection state and a checklist of what is still missing: app activation, permissions (with a link to request them) and the first message received.
- Only bound Feishu accounts can use a bot; everyone else is ignored. Bind with the one-time code shown in settings (valid 5 minutes), sent as `/bind <code>` to the bot in a private chat. A bot created by scanning binds the person who scanned automatically.
- Chat commands: `/new`, `/stop`, `/project`, `/status`, `/flat on|off` (groups) and `/bind <code>`. Other messages starting with `/` go to the conversation as they are.

## Groups and conversations

- In a group, @ the bot to start a conversation; each topic is its own conversation. In a topic that is already bound, bound users do not need to @ the bot (this needs the permission to read all group messages; without it, @ the bot there too). `/flat on` makes the whole group share one conversation.
- Each chat is bound to one project, chosen the first time you use it and changed with `/project`. Projects are not created from Feishu.
- Turns started in other clients are shown in the same topic and marked as coming from another client.

## Data

The App Secret is stored on the server in a private file and is never sent to clients; settings only show whether it is set. Images and files you send are downloaded by the server and attached to the conversation (up to 20 per message, 24 MB each).

With the plugin off, bots disconnect. They and their chats are kept and reconnect when the plugin is turned on again.
