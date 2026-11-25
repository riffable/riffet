import type { AgentDiscussionRequest } from '../agent.js';

/** CLIs accepting a single prompt get attributed history followed by the current question. */
export function discussionPrompt(messages: AgentDiscussionRequest['messages']): string {
  const question = messages.at(-1);
  if (!question || question.role !== 'user') throw new Error('A side chat requires a question');
  if (messages.length === 1) return question.content;
  return `Earlier side-chat messages (JSON):\n${JSON.stringify(messages.slice(0, -1))}\n\nCurrent question:\n${question.content}`;
}
