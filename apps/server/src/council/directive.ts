import type {
  CouncilDirective,
  CouncilDiscussion,
  CouncilEdits,
  CouncilLedger,
  CouncilModeration,
  CouncilPhase,
  CouncilProbe,
} from '../../../../packages/contracts/src/index.js';

/*
 * A judge, moderator, observer or reviewer records notes for the next prompts as JSON, in a turn of its own after the
 * speech (`recordTurn`); this reads them and checks them against the discussion.
 */

function parseObject(candidate: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function outermostObject(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start < 0 || end <= start ? undefined : parseObject(raw.slice(start, end + 1));
}

/**
 * A JSON object in a model answer, tolerating a Markdown fence and stray prose around it. The whole text and its outermost
 * braces come first, because edited text inside the JSON strings may itself hold a fence; the first fence is the last resort.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const whole = raw.trim();
  const found = parseObject(whole) ?? outermostObject(whole);
  if (found) return found;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(whole);
  return fenced ? outermostObject(fenced[1]!) : undefined;
}

const text = (value: unknown, max = 400): string | undefined =>
  typeof value === 'string' && value.trim() && value.trim() !== 'null' ? value.trim().slice(0, max) : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? value as T : fallback;

function ledgerOf(json: Record<string, unknown>): CouncilLedger {
  const sides: CouncilLedger['sides'] = {};
  for (const side of ['pro', 'con'] as const) {
    const entry = record(record(json.sides)[side]);
    const claim = text(entry.claim);
    if (claim) {
      const reinforced = text(entry.reinforced);
      const broken = text(entry.broken);
      sides[side] = { claim, ...(reinforced ? { reinforced } : {}), ...(broken ? { broken } : {}) };
    }
  }
  const crossExam = list(json.crossExam).slice(0, 8).flatMap(item => {
    const entry = record(item);
    const question = text(entry.question);
    return question ? [{
      asker: oneOf(entry.asker, ['pro', 'con'] as const, 'pro'),
      question,
      answered: oneOf(entry.answered, ['direct', 'dodged', 'pending'] as const, 'pending'),
    }] : [];
  });
  return {
    kind: 'ledger',
    sides,
    crossExam,
    intensity: oneOf(json.intensity, ['clashing', 'stalling'] as const, 'clashing'),
    action: oneOf(json.action, ['continue', 'closing'] as const, 'continue'),
  };
}

function moderationOf(json: Record<string, unknown>, seats: ReadonlySet<string>): CouncilModeration {
  const unanswered = text(json.unanswered);
  const convergence = oneOf(json.convergence, ['divergent', 'partial', 'converging', 'consensus'] as const, 'divergent');
  return {
    kind: 'moderation',
    positions: list(json.positions).flatMap(item => {
      const entry = record(item);
      const seatId = text(entry.seatId, 16);
      const stance = text(entry.stance, 200);
      return seatId && seats.has(seatId) && stance ? [{ seatId, stance }] : [];
    }),
    challenges: list(json.challenges).slice(0, 12).flatMap(item => {
      const entry = record(item);
      const from = text(entry.from, 16);
      const to = text(entry.to, 16);
      const point = text(entry.point);
      return from && to && from !== to && point && seats.has(from) && seats.has(to) ? [{ from, to, point }] : [];
    }),
    ...(unanswered ? { unanswered } : {}),
    convergence,
    action: oneOf(json.action, ['continue', 'conclude'] as const, convergence === 'consensus' ? 'conclude' : 'continue'),
  };
}

function probeOf(json: Record<string, unknown>, seats: ReadonlySet<string>): CouncilProbe {
  return {
    kind: 'probe',
    contradictions: list(json.contradictions).slice(0, 5).flatMap(item => {
      const entry = record(item);
      const title = text(entry.title, 120);
      const question = text(entry.question);
      const involved = list(entry.seats).filter((seat): seat is string => typeof seat === 'string' && seats.has(seat));
      return title && question ? [{ title, seats: involved, question }] : [];
    }),
    gaps: list(json.gaps).flatMap(gap => text(gap) ? [text(gap)!] : []).slice(0, 4),
  };
}

function editsOf(json: Record<string, unknown>, seatId: string, paragraphs: ReadonlySet<string>): CouncilEdits {
  return {
    kind: 'edits',
    edits: list(json.edits).slice(0, 4).flatMap((item, index) => {
      const entry = record(item);
      const para = text(entry.para, 8);
      const after = text(entry.after, 4_000);
      return para && paragraphs.has(para) && after ? [{
        id: `${seatId}-${index + 1}`,
        para,
        title: text(entry.title, 120) ?? para,
        before: text(entry.before, 4_000) ?? '',
        after,
      }] : [];
    }),
  };
}

/** The structured part of one speech, checked against the discussion; undefined when the phase has none. */
export function directiveFor(
  phase: CouncilPhase,
  json: Record<string, unknown> | undefined,
  discussion: CouncilDiscussion,
  seatId: string,
): CouncilDirective | undefined {
  if (!json) return undefined;
  switch (phase) {
    case 'ledger': return ledgerOf(json);
    case 'summary': return moderationOf(json, new Set(discussion.seats.filter(s => s.role === 'debater').map(s => s.id)));
    case 'probe': return probeOf(json, new Set(discussion.seats.map(seat => seat.id)));
    case 'review': return editsOf(json, seatId, new Set(discussion.document?.paragraphs.map(p => p.id) ?? []));
    default: return undefined;
  }
}
