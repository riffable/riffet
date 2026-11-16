import { extractIndexable, likePattern, normalizeQuery, snippet } from './messages.js';
import { mergeMessageHits } from './merge.js';

/** The search helpers the 助理's tools use; `app.ts` hands them over, because work-items sits beside search, not above it. */
export const assistantSearch = { extractIndexable, likePattern, normalizeQuery, snippet, mergeMessageHits };
