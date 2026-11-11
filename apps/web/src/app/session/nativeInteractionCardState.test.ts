import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NativeInteraction, NativeInteractionResponse, NativeInteractionResult } from '@contracts';
import type { NativeInteractionDraft, NativeInteractionSubmission } from './nativeInteractionDraft';
import {
  cardBusy, cardCanRetry, cardCanSync, cardDraft, cardFrozen, cardShown, cardStoredDraft, changeOtherText, interactionChanged,
  interactionFailed, interactionResponded, interactionSynced, interactionSyncFailed, interactionSyncStarted, restoreInteractionCard,
  retryInteraction, selectOption, submitInteraction, type InteractionCardState,
} from './nativeInteractionCardState';

/** The scenarios the Kotlin state machine runs too (`InteractionCardScenarioTest.kt`). */
type Step = { do: string; expect?: Record<string, unknown>; [key: string]: unknown };
const fixture = JSON.parse(readFileSync(new URL('../../../../mobile/client/fixtures/interaction-card/scenarios.json', import.meta.url), 'utf8')) as {
  interactions: Record<string, NativeInteraction>;
  scenarios: Array<{ name: string; interaction: string; saved?: { draft?: NativeInteractionDraft; submission?: Omit<NativeInteractionSubmission, 'interaction'> & { interaction: string } }; steps: Step[] }>;
};
const named = (name: string) => fixture.interactions[name]!;

function apply(state: InteractionCardState, step: Step): InteractionCardState {
  const text = (key: string) => step[key] as string;
  switch (step.do) {
    case 'none': return state;
    case 'interaction': return interactionChanged(state, named(text('interaction')));
    case 'select': return selectOption(state, text('id'));
    case 'other': return changeOtherText(state, text('text'));
    case 'submit': return submitInteraction(state, text('action'), text('requestId')) ?? state;
    case 'retry': return retryInteraction(state) ?? state;
    case 'responded': return interactionResponded(state, text('requestId'), text('status') as NativeInteractionResult['status'], step.message as string | undefined);
    case 'failed': return interactionFailed(state, text('requestId'), (step.status as number | null) ?? undefined, step.message as string | undefined);
    case 'syncStarted': return interactionSyncStarted(state);
    case 'syncFailed': return interactionSyncFailed(state, step.message as string | undefined);
    case 'synced': return interactionSynced(state, step.fresh ? named(text('fresh')) : null);
    default: throw new Error(`unknown event ${step.do}`);
  }
}

function observed(state: InteractionCardState, key: string): unknown {
  switch (key) {
    case 'phase': return state.submission?.phase ?? null;
    case 'frozen': return cardFrozen(state);
    case 'busy': return cardBusy(state);
    case 'canRetry': return cardCanRetry(state);
    case 'canSync': return cardCanSync(state);
    case 'edited': return state.edited;
    case 'storedDraft': return cardStoredDraft(state) !== undefined;
    case 'notice': return state.notice ?? null;
    case 'error': return state.error?.kind ?? null;
    case 'appliedRevision': return state.appliedRevision;
    case 'shownRevision': return cardShown(state).revision;
    case 'draft': return cardDraft(state);
    case 'request': return state.submission?.request satisfies NativeInteractionResponse | undefined;
    default: throw new Error(`unknown expectation ${key}`);
  }
}

describe('the answer card state machine', () => {
  for (const scenario of fixture.scenarios) {
    it(scenario.name, () => {
      const saved = scenario.saved?.submission;
      let state = restoreInteractionCard(named(scenario.interaction), scenario.saved?.draft, saved ? { ...saved, interaction: named(saved.interaction) } : undefined);
      scenario.steps.forEach((step, index) => {
        state = apply(state, step);
        for (const [key, value] of Object.entries(step.expect ?? {})) {
          expect(observed(state, key), `step ${index + 1} (${step.do}): ${key}`).toEqual(value);
        }
      });
    });
  }
});
