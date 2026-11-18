import type {
  CouncilDebateState,
  CouncilInsightAnnotation,
  CouncilInsightTask,
  CouncilModelParticipant,
  CouncilPrismState,
} from '../../../../packages/contracts/src/index.js';

/** Extracts a JSON object from a model response, tolerating markdown fences and leading prose. */
export function parseJsonObject<T extends Record<string, unknown>>(raw: string): T | undefined {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
  } catch { /* fall through to brace extraction */ }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
    } catch { /* ignore */ }
  }
  return undefined;
}

/**
 * Extracts a streaming JSON string field (e.g. `"argument"` or `"text"`) while the JSON object
 * is still arriving token-by-token. If the text is plain prose (not JSON), returns it directly.
 */
export function extractStreamingField(raw: string, keys: readonly string[] = ['argument', 'text']): string {
  const trimmed = raw.trimStart().replace(/^```(?:json)?\s*/i, '');
  if (!trimmed.startsWith('{')) return raw;
  for (const key of keys) {
    const marker = new RegExp(`"${key}"\\s*:\\s*"`);
    const match = marker.exec(trimmed);
    if (!match) continue;
    let out = '';
    let i = match.index + match[0].length;
    while (i < trimmed.length) {
      const ch = trimmed[i]!;
      if (ch === '\\') {
        const next = trimmed[i + 1];
        if (next === undefined) break;
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else out += next;
        i += 2;
        continue;
      }
      if (ch === '"') break;
      out += ch;
      i += 1;
    }
    if (out) return out;
  }
  return '';
}

export function splitDocumentParagraphs(text: string): Array<{ id: string; text: string }> {
  const blocks = text
    .split(/\n{2,}/)
    .map(chunk => chunk.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (blocks.length <= 1) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) return lines.slice(0, 24).map((line, i) => ({ id: `P${i + 1}`, text: line }));
  }
  return blocks.slice(0, 24).map((block, i) => ({ id: `P${i + 1}`, text: block }));
}

export const DEBATE_SYSTEM = [
  '你正在参加一场多模型工程与产品方案辩论。',
  '规则：',
  '1. 只陈述实质论据、工程权衡与可验证证据，避免客套、空话和情绪词。',
  '2. 站在所分配的立场或视角充分论证，同时直面其他辩手的关键质疑与反例。',
  '3. 若同一立场有多位辩手，请聚焦不同维度（架构、体验、维护成本、长期演进）形成互补。',
  '4. 语言精炼清晰，中文为主，保留必要的英文技术标识。',
].join('\n');

export function debateRoundPrompt(args: {
  proposition: string;
  sideLabel: string;
  allSides: string[];
  roundNum: number;
  memberIndex: number;
  teamSize: number;
  priorTranscript?: string;
  incomingQuestions?: Array<{ fromLabel: string; text: string }>;
}): { system: string; user: string } {
  const roleHint = args.teamSize > 1 ? `（你是「${args.sideLabel}」第 ${args.memberIndex + 1}/${args.teamSize} 位辩手，请补充差异化视角）` : '';
  const lines = [
    `议题：${args.proposition}`,
    `参与方：${args.allSides.join(' vs ')}`,
    `你的立场：${args.sideLabel}${roleHint}`,
    `当前轮次：第 ${args.roundNum} 轮`,
  ];
  if (args.priorTranscript) {
    lines.push('', `此前各方发言：\n${args.priorTranscript}`);
  }
  if (args.incomingQuestions?.length) {
    lines.push('', '向你方提出的追问：', ...args.incomingQuestions.map((q, i) => `${i + 1}. [${q.fromLabel}] ${q.text}`));
  }
  lines.push(
    '',
    '请以 JSON 对象回复（不要包含多余说明）：',
    '{',
    args.incomingQuestions?.length ? '  "reply": "用 1-2 句正面回应上述追问（必须直接作答）",' : '',
    args.incomingQuestions?.length ? '  "replyStatus": "direct | partial | dodged",' : '',
    '  "claim": "不超过 24 字的核心论点摘要",',
    args.roundNum > 1 ? '  "weakness": "不超过 18 字的诚实局限（若无则写 null）",' : '',
    '  "argument": "120-240 字的发言正文，支持行内代码与换行",',
    '  "questionTarget": "你想追问的另一方名称（若不追问可写 null）",',
    '  "questionSummary": "不超过 14 字的追问标题（若不追问可写 null）",',
    '  "question": "向对方提出一个具体且无法回避的追问（若不追问可写 null）"',
    '}',
  );
  return { system: DEBATE_SYSTEM, user: lines.filter(Boolean).join('\n') };
}

export function debateJudgePrompt(debate: CouncilDebateState): { system: string; user: string } {
  const bySide = debate.sides.map(side => {
    const turns = debate.rounds.flatMap(r => r.turns.filter(t => t.sideId === side.id).map(t => `第${r.num}轮 [${t.speaker.model}]: ${t.text}`));
    return `【${side.label}】（${side.models.map(m => m.model).join('、')}）\n${turns.join('\n')}`;
  }).join('\n\n');
  return {
    system: '你是客观的技术方案评委，只根据各方论据密度、边界处理与追问回应质量做出判断，给出明确可落地的工程结论。',
    user: `议题：${debate.proposition}\n\n${bySide}\n\n请以 JSON 对象回复：\n{\n  "winner": "不超过 20 字的总结判断（例如：正方论据更扎实 / 需按场景折中）",\n  "takeaway": "100-200 字的落地结论，指出适用前提与下一步行动"\n}`,
  };
}

export function debateHostPrompt(args: {
  proposition: string;
  sideLabel: string;
  hostQuestion: string;
  context: string;
}): { system: string; user: string } {
  return {
    system: DEBATE_SYSTEM,
    user: `议题：${args.proposition}\n你的立场：${args.sideLabel}\n前文摘要：\n${args.context}\n\n主持人追问：${args.hostQuestion}\n\n请用 80-160 字从「${args.sideLabel}」立场直接作答。`,
  };
}

export function prismExplorePrompt(topic: string): { system: string; user: string } {
  return {
    system: '你是独立思考的技术顾问。请先做简短推敲，再给出清晰明确的方案判断。不要迎合、不要面面俱到地和稀泥，必须亮出明确立场。',
    user: `讨论议题：${topic}\n\n请以 JSON 对象回复：\n{\n  "stance": "不超过 10 字的明确立场标签",\n  "thought": "不超过 60 字的核心权衡过程",\n  "text": "100-200 字的观点正文，明确说明取舍依据"\n}`,
  };
}

export function prismProbePrompt(
  topic: string,
  participants: CouncilModelParticipant[],
  explore: CouncilPrismState['explore'],
): { system: string; user: string } {
  const answers = participants.map(p => {
    const e = explore[p.id];
    return `[${p.id}] ${p.label}（立场：${e?.stance ?? ''}）:\n${e?.text ?? ''}`;
  }).join('\n\n');
  return {
    system: '你是冷静的分析者。从各方独立回答中找出真正的前提冲突与尚未讨论的工程约束，每个冲突必须精确引用双方原话中的短句。',
    user: `讨论议题：${topic}\n\n各方回答：\n${answers}\n\n请以 JSON 对象回复：\n{\n  "contradictions": [\n    {\n      "title": "不超过 18 字的分歧标题",\n      "leftModelId": "左侧模型 id（必须来自方括号内）",\n      "leftQuote": "直接摘自左侧模型回答的一句原话（10-32 字）",\n      "rightModelId": "右侧模型 id",\n      "rightQuote": "直接摘自右侧模型回答的一句原话（10-32 字）",\n      "question": "针对该分歧的尖锐追问"\n    }\n  ],\n  "gaps": ["1-2 条各方都未提到的工程风险或约束"]\n}`,
  };
}

export function prismDeepenPrompt(args: {
  topic: string;
  model: CouncilModelParticipant;
  ownExplore: CouncilPrismState['explore'][string];
  questions: string[];
  othersSummary: string;
}): { system: string; user: string } {
  return {
    system: '请直面追问与其他模型的反驳。如果对方论据更有说服力，请坦诚修正自己的立场；如果坚持原立场，请说明原因。',
    user: [
      `议题：${args.topic}`,
      `你此前的立场：${args.ownExplore.stance}`,
      `你此前的观点：${args.ownExplore.text}`,
      `其他模型要点：\n${args.othersSummary}`,
      `本轮必须回应的追问：\n${args.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      '',
      '请以 JSON 对象回复：',
      '{',
      '  "shifted": true 或 false,',
      '  "newStance": "不超过 10 字的当前立场（若未变可写：维持原判）",',
      '  "challenge": "不超过 20 字的本轮回应焦点",',
      '  "text": "100-180 字的回应正文"',
      '}',
    ].join('\n'),
  };
}

export function prismVerdictPrompt(topic: string, prism: CouncilPrismState): { system: string; user: string } {
  const details = prism.participants.map(p => {
    const e = prism.explore[p.id];
    const d = prism.deepen[p.id];
    return `${p.label}：初探「${e?.stance ?? ''}」→ 回应「${d?.newStance ?? ''}」\n${d?.text ?? e?.text ?? ''}`;
  }).join('\n\n');
  return {
    system: '请汇总多轮讨论后的收敛方案，输出清晰、可执行、没有空话的工程结论。',
    user: `议题：${topic}\n\n讨论过程：\n${details}\n\n请以 JSON 对象回复：\n{\n  "headline": "不超过 24 字的一句话结论",\n  "analysis": "120-260 字的收敛结论，可用编号要点列出具体做法与边界"\n}`,
  };
}

const INSIGHT_ROLES: Array<{ task: CouncilInsightTask; label: string; focus: string }> = [
  { task: 'correct', label: '修改', focus: '找出事实错误、逻辑矛盾、边界遗漏或不可落地的条款，给出精确替代文本。' },
  { task: 'augment', label: '补充', focus: '找出被省略的前提、状态机分支、错误恢复或权限说明，给出可插入的补充内容。' },
  { task: 'diagnose', label: '问题', focus: '诊断潜在安全、性能、多端兼容或隐含假设风险，指明缺失的信息。' },
  { task: 'restructure', label: '结构', focus: '找出结构顺序不当、前置说明缺失或职责混淆的段落，提出更清晰的组织方式。' },
];

export function insightRoleFor(index: number) {
  return INSIGHT_ROLES[index % INSIGHT_ROLES.length]!;
}

export function insightGoalPrompt(docText: string): { system: string; user: string } {
  return {
    system: '用一句话提炼文档的核心目标（不超过 40 字）。',
    user: `文档内容：\n${docText.slice(0, 6000)}\n\n请直接输出一句话目标，不加前缀。`,
  };
}

export function insightReviewPrompt(args: {
  goal: string;
  paragraphs: Array<{ id: string; text: string }>;
  role: { task: CouncilInsightTask; label: string; focus: string };
}): { system: string; user: string } {
  const numbered = args.paragraphs.map(p => `[${p.id}] ${p.text}`).join('\n');
  return {
    system: `你是文档审阅者，本轮负责「${args.role.label}」视角：${args.role.focus}`,
    user: [
      `文档目标：${args.goal}`,
      `原文分段：\n${numbered}`,
      '',
      '请以 JSON 对象回复，给出 1-2 条最关键的段落级修改建议：',
      '{',
      '  "summary": "不超过 14 字的审阅结论摘要",',
      '  "text": "60-120 字的审阅说明",',
      '  "annotations": [',
      '    {',
      '      "para": "P1 / P2 / ...",',
      '      "title": "不超过 16 字的修改标题",',
      '      "before": "精确摘自该段落中需要替换的原句片段（若为新增则写该段末句）",',
      '      "after": "修改或补充后的建议文本"',
      '    }',
      '  ]',
      '}',
    ].join('\n'),
  };
}

export function insightSynthesizePrompt(goal: string, annotations: CouncilInsightAnnotation[]): { system: string; user: string } {
  const items = annotations.map(a => `- [${a.para}] (${a.taskLabel}) ${a.title}: ${a.after}`).join('\n');
  return {
    system: '用 1-2 句话总结本次审阅最值得优先采纳的改动。',
    user: `文档目标：${goal}\n\n审阅建议：\n${items}\n\n请直接给出 60 字以内的汇总建议。`,
  };
}
