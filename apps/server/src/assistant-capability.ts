import { z } from 'zod/v4';
import { AppError } from './errors.js';

/** A domain-owned, read-only operation. Only these handlers can be reached through capability_read. */
export function defineRead<T extends z.ZodObject>(
  id: string, description: string, keywords: readonly string[], args: T,
  read: (sessionId: string, args: z.output<T>) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(id)) throw new Error(`Invalid assistant capability id: ${id}`);
  const domain = id.split('.')[0]!;
  return {
    entry: { id, domain, description, inputSchema: z.toJSONSchema(args, { target: 'draft-7', io: 'input' }) },
    keywords,
    read(sessionId: string, input: unknown) {
      const parsed = args.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_ARGUMENT', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', '));
      return read(sessionId, parsed.data);
    },
  };
}

export type AssistantRead = ReturnType<typeof defineRead>;

export interface SettingCommandTurn {
  sessionId: string;
  runId: string;
  previousRunId?: string;
  ownerText?: string;
  assertCurrent(): void;
}

/** A foreground setting command has its own MCP name and cannot be selected by capability_read. */
export function defineSettingCommand<T extends z.ZodObject>(
  name: string, description: string, args: T,
  change: (args: z.output<T>, turn: () => SettingCommandTurn) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  return {
    definition: { name, description, inputSchema: z.toJSONSchema(args, {target:'draft-7'}) },
    call(input: unknown, authorize: () => void, turn?: () => Omit<SettingCommandTurn, 'assertCurrent'>) {
      const parsed = args.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_ARGUMENT', 'Check the tool schema for the accepted setting fields and values.');
      const assertCurrent = () => authorize();
      assertCurrent();
      return change(parsed.data, () => {
        if (!turn) throw new AppError('WORKBENCH_UNAVAILABLE', 'Send a new message from the Riffet workbench.');
        return { ...turn(), assertCurrent };
      });
    },
  };
}
export type AssistantSettingCommand = ReturnType<typeof defineSettingCommand>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const toolObject = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

export interface BoundAssistantTool {
  definition: ToolDefinition;
  audience: 'assistant' | 'task-read' | 'run' | 'supervise';
  call(args: Record<string,unknown>, context: {sessionId: string; taskScope?: string}): Promise<Record<string,unknown>>;
}
