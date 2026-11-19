import type { CouncilFormat } from '../../../../../packages/contracts/src/index.js';
import { ld } from './ld.js';
import { prism } from './prism.js';
import { review } from './review.js';
import { roundtable } from './roundtable.js';
import type { FormatSpec } from './shared.js';

export const FORMATS: Record<CouncilFormat, FormatSpec> = { ld, roundtable, prism, review };
export { REVIEW_TASKS } from './review.js';
export { compose, recordTurn, type SpeechSpec } from './shared.js';
