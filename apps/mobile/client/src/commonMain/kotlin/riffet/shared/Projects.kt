package riffet.shared

import riffet.contracts.Project

/** The server-owned project that holds quick chats; it is never listed as an ordinary project. */
private const val QuickChatSystem = "quick-chat"

/** True for the built-in quick chat project. */
val Project.isQuickChat: Boolean get() = system == QuickChatSystem

/** The server-owned project of the personal assistant; its one conversation has its own entry, not a project row. */
private const val AssistantSystem = "assistant"

/** True for the personal assistant's project. */
val Project.isAssistant: Boolean get() = system == AssistantSystem
