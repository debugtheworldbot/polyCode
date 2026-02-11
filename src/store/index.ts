import { create } from 'zustand';
import type {
  Project,
  Session,
  ChatMessage,
  AppSettings,
  SessionEvent,
  AIProvider,
  ClaudePermissionMode,
} from '../types';
import * as api from '../services/tauri';
import { setLanguage } from '../i18n';

const DEFAULT_WINDOW_TRANSPARENCY = 80;
const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = 'acceptEdits';

type JsonRecord = Record<string, unknown>;
type InsertMode = 'append' | 'replace_or_create' | 'new';

interface ParsedEventMessage {
  role: ChatMessage['role'];
  messageType: ChatMessage['message_type'];
  content: string;
  mode: InsertMode;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function normalizeItemType(value: string): string {
  return value.replace(/[_-]/g, '').toLowerCase();
}

function firstNonEmptyString(values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function compactText(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function formatErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (isRecord(error)) {
    const direct = firstNonEmptyString([
      error.message,
      error.error,
      error.details,
      error.reason,
    ]);
    if (direct) return direct;
  }
  return 'Failed to send message';
}

function normalizeMultiline(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function asCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
  }
  return null;
}

function firstNonEmptyCount(values: Array<unknown>): number | null {
  for (const value of values) {
    const count = asCount(value);
    if (count !== null) return count;
  }
  return null;
}

function readFirstText(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    if (!value.trim()) continue;
    return value;
  }
  return null;
}

function renderFileChangeLine(line: unknown): string | null {
  if (typeof line === 'string') {
    return line.trim() ? line : null;
  }

  if (!isRecord(line)) return null;

  const text = readFirstText(line, ['text', 'content', 'value']);
  if (!text) return null;

  const prefixedText = /^\s*[+-]/.test(text) ? text : null;
  if (prefixedText) return prefixedText;

  const explicitPrefix = readFirstText(line, ['prefix', 'sign']);
  if (explicitPrefix) {
    return `${explicitPrefix}${text}`;
  }

  const kind = normalizeItemType(
    readFirstText(line, ['type', 'kind', 'changeType', 'change_type']) ?? ''
  );
  if (kind.includes('add') || kind.includes('insert')) return `+ ${text}`;
  if (kind.includes('remove') || kind.includes('delete')) return `- ${text}`;
  if (kind.includes('context') || kind.includes('same') || kind.includes('unchanged')) return `  ${text}`;

  return text;
}

function renderFileChangeBody(change: JsonRecord): string | null {
  const inline = readFirstText(change, [
    'preview',
    'snippet',
    'diff',
    'patch',
    'text',
    'details',
    'rendered',
    'content',
  ]);
  if (inline) return normalizeMultiline(inline);

  const hunks = Array.isArray(change.hunks) ? change.hunks : [];
  const renderedHunks = hunks
    .map((hunk) => {
      if (!isRecord(hunk)) return null;
      const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
      const renderedLines = lines
        .map((line) => renderFileChangeLine(line))
        .filter((line): line is string => !!line && line.trim().length > 0);
      if (renderedLines.length === 0) return null;
      const header = readFirstText(hunk, ['header', 'title', 'range']);
      return header ? `${header}\n${renderedLines.join('\n')}` : renderedLines.join('\n');
    })
    .filter((block): block is string => !!block);
  if (renderedHunks.length > 0) return renderedHunks.join('\n');

  const lines = Array.isArray(change.lines) ? change.lines : [];
  const renderedLines = lines
    .map((line) => renderFileChangeLine(line))
    .filter((line): line is string => !!line && line.trim().length > 0);
  if (renderedLines.length > 0) return renderedLines.join('\n');

  return null;
}

function renderFileChangeEntry(change: JsonRecord, index: number): string {
  const path = firstNonEmptyString([change.path, change.filePath, change.file]) || `file ${index + 1}`;
  const added = firstNonEmptyCount([
    change.added,
    change.additions,
    change.addedLines,
    change.added_lines,
    change.insertions,
    change.inserted,
  ]);
  const removed = firstNonEmptyCount([
    change.removed,
    change.deletions,
    change.removedLines,
    change.removed_lines,
    change.deleted,
  ]);

  const countPieces: string[] = [];
  if (added !== null) countPieces.push(`+${added}`);
  if (removed !== null) countPieces.push(`-${removed}`);

  const title = countPieces.length > 0
    ? `• Edited ${path} (${countPieces.join(' ')})`
    : `• Edited ${path}`;

  const body = renderFileChangeBody(change);
  return body ? `${title}\n${body}` : title;
}

function buildFileChangeMessage(item: JsonRecord): string {
  const changes = Array.isArray(item.changes)
    ? item.changes.filter((change): change is JsonRecord => isRecord(change))
    : [];
  const status = asString(item.status);

  const paths = changes
    .map((change) => firstNonEmptyString([change.path, change.filePath, change.file]))
    .filter((path): path is string => !!path && path.trim().length > 0);

  let summary: string;
  if (paths.length === 1) {
    summary = `Edited ${paths[0]}`;
  } else if (paths.length > 1) {
    const shown = paths.slice(0, 2);
    const remaining = paths.length - shown.length;
    summary = remaining > 0
      ? `Edited ${shown.join(', ')} +${remaining} files`
      : `Edited ${shown.join(', ')}`;
  } else {
    const count = changes.length;
    summary = count > 0
      ? `Edited ${count} file${count === 1 ? '' : 's'}`
      : 'Edited files';
  }

  const summaryWithStatus = status ? `${summary} (${status})` : summary;

  const topLevelDetails = readFirstText(item, ['text', 'preview', 'diff', 'patch', 'details']);
  if (topLevelDetails) {
    const normalized = normalizeMultiline(topLevelDetails);
    if (normalized) {
      const editStyle = /^•?\s*edited\b/i.test(normalized);
      if (editStyle) return normalized;
      return `${summaryWithStatus}\n${normalized}`;
    }
  }

  const changeBlocks = changes.map((change, index) => renderFileChangeEntry(change, index));
  const hasBody = changeBlocks.some((block) => block.includes('\n'));

  if (!hasBody) {
    if (changeBlocks.length === 1) {
      const headerOnly = normalizeMultiline(changeBlocks[0].replace(/^•\s*/, ''));
      if (headerOnly) return headerOnly;
    }
    return summaryWithStatus;
  }

  if (changeBlocks.length === 1 && !status) {
    return changeBlocks[0];
  }

  return `${summaryWithStatus}\n${changeBlocks.join('\n\n')}`;
}

function parseCodexLiveStatus(data: JsonRecord): string | null | undefined {
  const method = asString(data.method);
  if (!method) return undefined;

  const params = isRecord(data.params) ? data.params : null;

  if (method === 'turn/completed') return null;
  if (method === 'turn/started') return 'Thinking';
  if (method === 'error') return 'Error';

  const turnLike = method.startsWith('turn/');
  if (turnLike && params) {
    const direct = firstNonEmptyString([
      params.title,
      params.statusText,
      params.status_text,
      params.message,
      params.summary,
      params.status,
    ]);
    if (direct) return compactText(direct);
  }

  if (!params) return undefined;
  if (method !== 'item/started' && method !== 'item/updated' && method !== 'item/in_progress') {
    return undefined;
  }

  const item = isRecord(params.item) ? params.item : null;
  if (!item) return undefined;

  const explicit = firstNonEmptyString([
    item.title,
    item.statusText,
    item.status_text,
    item.message,
    item.description,
    item.summary,
    params.title,
    params.statusText,
    params.status_text,
    params.message,
  ]);
  if (explicit) return compactText(explicit);

  const itemType = asString(item.type);
  if (!itemType) return 'Thinking';

  const normalizedType = normalizeItemType(itemType);
  if (normalizedType === 'commandexecution') {
    const argv = Array.isArray(item.argv)
      ? item.argv.filter((v): v is string => typeof v === 'string')
      : [];
    const command = asString(item.command) || (argv.length > 0 ? argv.join(' ') : null);
    if (command) return compactText(`Running ${command}`);
    return 'Running command';
  }

  if (normalizedType === 'filechange') {
    return 'Editing files';
  }

  if (normalizedType === 'mcptoolcall') {
    const server = asString(item.server);
    const tool = asString(item.tool);
    if (server && tool) return `Using ${server}/${tool}`;
    if (tool) return `Using ${tool}`;
    return 'Using MCP tool';
  }

  if (normalizedType === 'agentmessage') {
    return 'Writing response';
  }

  return 'Thinking';
}

function createMessage(sessionId: string, parsed: ParsedEventMessage): ChatMessage {
  return {
    id: crypto.randomUUID(),
    session_id: sessionId,
    role: parsed.role,
    content: parsed.content,
    message_type: parsed.messageType,
    created_at: Date.now(),
  };
}

function mergeMessage(
  existing: ChatMessage[],
  sessionId: string,
  parsed: ParsedEventMessage
): ChatMessage[] {
  if (!parsed.content) return existing;

  const last = existing[existing.length - 1];
  const isSameKind =
    last &&
    last.role === parsed.role &&
    last.message_type === parsed.messageType;

  if (parsed.mode === 'append') {
    if (isSameKind) {
      const updated = [...existing];
      updated[updated.length - 1] = {
        ...last,
        content: `${last.content}${parsed.content}`,
      };
      return updated;
    }
    return [...existing, createMessage(sessionId, parsed)];
  }

  if (parsed.mode === 'replace_or_create') {
    if (isSameKind) {
      if (last.content === parsed.content) return existing;
      const updated = [...existing];
      updated[updated.length - 1] = { ...last, content: parsed.content };
      return updated;
    }
    return [...existing, createMessage(sessionId, parsed)];
  }

  // Guard against duplicated "new" events from provider stream.
  if (isSameKind && last.content === parsed.content) {
    return existing;
  }

  if (parsed.messageType === 'tool') {
    const recent = existing.slice(-8);
    const hasRecentDuplicate = recent.some(
      (msg) =>
        msg.role === parsed.role &&
        msg.message_type === parsed.messageType &&
        msg.content === parsed.content
    );
    if (hasRecentDuplicate) return existing;
  }

  return [...existing, createMessage(sessionId, parsed)];
}

function formatClaudeToolMessage(name: string, input: JsonRecord): string {
  const filePath = asString(input.file_path) || asString(input.path);

  switch (name) {
    case 'Read':
      return filePath ? `Read ${filePath}` : 'Read file';
    case 'Edit': {
      const target = filePath || 'file';
      const oldStr = asString(input.old_string);
      const newStr = asString(input.new_string);
      if (oldStr || newStr) {
        const lines: string[] = [];
        if (oldStr) for (const l of oldStr.split('\n')) lines.push(`- ${l}`);
        if (newStr) for (const l of newStr.split('\n')) lines.push(`+ ${l}`);
        return `Update ${target}\n${lines.join('\n')}`;
      }
      return `Update ${target}`;
    }
    case 'Write':
      return filePath ? `Write ${filePath}` : 'Write file';
    case 'Bash': {
      const cmd = asString(input.command);
      return cmd ? `Ran \`${compactText(cmd, 80)}\`` : 'Ran command';
    }
    case 'Grep': {
      const pattern = asString(input.pattern);
      return pattern ? `Searched \`${compactText(pattern, 60)}\`` : 'Searched';
    }
    case 'Glob': {
      const pattern = asString(input.pattern);
      return pattern ? `Searched \`${compactText(pattern, 60)}\`` : 'Searched files';
    }
    case 'WebSearch': {
      const query = asString(input.query);
      return query ? `Searched \`${compactText(query, 60)}\`` : 'Web search';
    }
    case 'WebFetch': {
      const url = asString(input.url);
      return url ? `Fetched ${compactText(url, 80)}` : 'Fetched URL';
    }
    case 'Task': {
      const desc = asString(input.description);
      return desc ? `Task: ${compactText(desc, 80)}` : 'Task';
    }
    default:
      return name;
  }
}

function claudeToolLiveStatus(name: string): string {
  switch (name) {
    case 'Read': return 'Reading file';
    case 'Edit': return 'Editing file';
    case 'Write': return 'Writing file';
    case 'Bash': return 'Running command';
    case 'Grep': case 'Glob': return 'Searching';
    case 'WebSearch': return 'Searching web';
    case 'WebFetch': return 'Fetching URL';
    case 'Task': return 'Running task';
    default: return `Using ${name}`;
  }
}

function parseClaudeLiveStatus(data: JsonRecord): string | null | undefined {
  const type = asString(data.type);
  if (!type) return undefined;

  if (type === 'result') return null;

  if (type === 'system') {
    const subtype = asString(data.subtype);
    if (subtype === 'init') {
      const model = asString(data.model);
      return model ? `Initialized (${model})` : 'Initialized';
    }
    return subtype ? compactText(subtype.replace(/[_-]/g, ' ')) : 'Initializing';
  }

  if (type === 'assistant') {
    const message = isRecord(data.message) ? data.message : null;
    const stopReason = firstNonEmptyString([
      message ? message.stop_reason : null,
      message ? message.stopReason : null,
    ]);
    if (stopReason === 'tool_use') return 'Using tool';
    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'Finalizing response';
    return 'Writing response';
  }

  if (type !== 'stream_event') return undefined;

  const evt = isRecord(data.event) ? data.event : null;
  if (!evt) return 'Thinking';

  const evtType = asString(evt.type);
  if (!evtType) return 'Thinking';

  if (evtType === 'message_start') {
    const message = isRecord(evt.message) ? evt.message : null;
    const model = firstNonEmptyString([message ? message.model : null, data.model]);
    return model ? `Thinking (${model})` : 'Thinking';
  }

  if (evtType === 'content_block_start') {
    const block = isRecord(evt.content_block) ? evt.content_block : null;
    if (!block) return 'Thinking';

    const blockType = asString(block.type);
    if (blockType === 'tool_use') {
      const toolName = asString(block.name) || 'tool';
      return claudeToolLiveStatus(toolName);
    }
    if (blockType === 'text') return 'Writing response';
    if (blockType === 'thinking') return 'Thinking';
    return 'Thinking';
  }

  if (evtType === 'content_block_delta') {
    const delta = isRecord(evt.delta) ? evt.delta : null;
    if (!delta) return 'Thinking';

    const deltaType = asString(delta.type);
    if (deltaType === 'text_delta') return 'Writing response';
    if (deltaType === 'thinking_delta') return 'Thinking';
    if (deltaType === 'input_json_delta') return 'Preparing tool input';
    return 'Thinking';
  }

  if (evtType === 'message_delta') {
    const delta = isRecord(evt.delta) ? evt.delta : null;
    const stopReason = firstNonEmptyString([
      delta ? delta.stop_reason : null,
      delta ? delta.stopReason : null,
      evt.stop_reason,
      evt.stopReason,
    ]);
    if (stopReason === 'tool_use') return 'Using tool';
    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'Finalizing response';
    return 'Thinking';
  }

  if (evtType === 'message_stop') return 'Finalizing response';
  if (evtType === 'ping') return undefined;

  return 'Thinking';
}

function parseGeminiLiveStatus(data: JsonRecord): string | null | undefined {
  const phase = asString(data.phase) || asString(data.status);
  if (phase === 'completed' || phase === 'done' || phase === 'result') return null;
  if (phase === 'error' || phase === 'failed') return 'Error';

  const explicit = firstNonEmptyString([
    data.liveStatus,
    data.live_status,
    data.message,
  ]);
  if (explicit) return compactText(explicit);

  const delta = asString(data.delta);
  if (typeof delta === 'string' && delta.trim()) return 'Writing response';

  return 'Thinking';
}

function parseClaudeMessage(data: JsonRecord): ParsedEventMessage[] {
  const type = asString(data.type);
  if (!type) return [];

  if (type === 'system') {
    const subtype = asString(data.subtype);
    if (subtype === 'init') {
      const model = asString(data.model) || 'default model';
      const permissionMode = asString(data.permissionMode) || asString(data.permission_mode) || 'default';
      const toolCount = Array.isArray(data.tools) ? data.tools.length : 0;
      return [{
        role: 'system',
        messageType: 'tool',
        content: `Claude initialized (${model}, ${permissionMode}, ${toolCount} tools)`,
        mode: 'new',
      }];
    }
    return [];
  }

  if (type !== 'assistant') {
    const raw = asString(data.raw);
    if (raw && raw.trim()) {
      return [{
        role: 'system',
        messageType: 'tool',
        content: compactText(raw, 200),
        mode: 'new',
      }];
    }
    return [];
  }

  const parsed: ParsedEventMessage[] = [];
  const message = isRecord(data.message) ? data.message : null;

  if (message) {
    const content = message.content;
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolMessages: string[] = [];

    if (typeof content === 'string') {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        const blockType = asString(block.type);
        if (blockType === 'text') {
          const text = asString(block.text);
          if (text) textParts.push(text);
          continue;
        }

        if (blockType === 'thinking') {
          const thinking = firstNonEmptyString([block.thinking, block.text]);
          if (thinking) reasoningParts.push(thinking);
          continue;
        }

        if (blockType === 'tool_use') {
          const name = asString(block.name) || 'Tool';
          const input = isRecord(block.input) ? block.input : {};
          toolMessages.push(formatClaudeToolMessage(name, input));
        }
      }
    }

    if (reasoningParts.length > 0) {
      parsed.push({
        role: 'assistant',
        messageType: 'reasoning',
        content: reasoningParts.join('\n\n'),
        mode: 'replace_or_create',
      });
    }

    for (const toolContent of toolMessages) {
      parsed.push({
        role: 'assistant',
        messageType: 'tool',
        content: toolContent,
        mode: 'new',
      });
    }

    if (textParts.length > 0) {
      parsed.push({
        role: 'assistant',
        messageType: 'text',
        content: textParts.join('\n'),
        mode: 'replace_or_create',
      });
    }
  }

  const topLevelError = asString(data.error);
  if (topLevelError && topLevelError.trim()) {
    parsed.push({
      role: 'system',
      messageType: 'error',
      content: topLevelError,
      mode: 'new',
    });
  }

  return parsed;
}

function parseCodexEvent(data: JsonRecord): ParsedEventMessage | null {
  const rpcError = isRecord(data.error) ? data.error : null;
  if (rpcError) {
    return {
      role: 'system',
      messageType: 'error',
      content: asString(rpcError.message) || JSON.stringify(rpcError),
      mode: 'new',
    };
  }

  const method = asString(data.method);
  if (!method) return null;

  const params = isRecord(data.params) ? data.params : null;
  if (!params) return null;

  if (method === 'item/agentMessage/delta') {
    const delta = asString(params.delta);
    if (!delta) return null;
    return {
      role: 'assistant',
      messageType: 'text',
      content: delta,
      mode: 'append',
    };
  }

  if (method === 'item/completed') {
    const item = isRecord(params.item) ? params.item : null;
    if (!item) return null;

    const itemType = asString(item.type);
    if (!itemType) return null;
    const normalizedType = normalizeItemType(itemType);

    if (normalizedType === 'agentmessage') {
      const text = asString(item.text);
      if (!text) return null;
      return {
        role: 'assistant',
        messageType: 'text',
        content: text,
        mode: 'replace_or_create',
      };
    }

    if (normalizedType === 'commandexecution') {
      const argv = Array.isArray(item.argv)
        ? item.argv.filter((v): v is string => typeof v === 'string')
        : [];
      const command = asString(item.command) || (argv.length > 0 ? argv.join(' ') : 'command');
      const exitCode = asNumber(item.exitCode) ?? asNumber(item.exit_code);
      const durationMs = asNumber(item.durationMs) ?? asNumber(item.duration_ms);
      const status = asString(item.status);
      const details: string[] = [];
      if (exitCode !== null) details.push(`exit ${exitCode}`);
      else if (status) details.push(status);
      if (durationMs !== null) details.push(`${Math.round(durationMs)}ms`);

      return {
        role: 'assistant',
        messageType: 'tool',
        content: details.length > 0
          ? `Ran \`${command}\` (${details.join(', ')})`
          : `Ran \`${command}\``,
        mode: 'new',
      };
    }

    if (normalizedType === 'filechange') {
      return {
        role: 'assistant',
        messageType: 'tool',
        content: buildFileChangeMessage(item),
        mode: 'new',
      };
    }

    if (normalizedType === 'mcptoolcall') {
      const server = asString(item.server) || 'mcp';
      const tool = asString(item.tool) || 'tool';
      const status = asString(item.status) || 'completed';
      return {
        role: 'assistant',
        messageType: 'tool',
        content: `[MCP] ${server}/${tool} (${status})`,
        mode: 'new',
      };
    }

    return null;
  }

  if (method === 'error') {
    const err = isRecord(params.error) ? params.error : null;
    return {
      role: 'system',
      messageType: 'error',
      content: err ? asString(err.message) || JSON.stringify(err) : 'Codex error',
      mode: 'new',
    };
  }

  if (method === 'turn/completed') {
    const turn = isRecord(params.turn) ? params.turn : null;
    if (!turn) return null;

    if (asString(turn.status) === 'failed') {
      const err = isRecord(turn.error) ? turn.error : null;
      return {
        role: 'system',
        messageType: 'error',
        content: err ? asString(err.message) || JSON.stringify(err) : 'Codex turn failed',
        mode: 'new',
      };
    }
  }

  return null;
}

function readTokenBreakdown(value: unknown): {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
} | null {
  const record = isRecord(value) ? value : null;
  if (!record) return null;

  const totalTokens = asCount(record.totalTokens ?? record.total_tokens);
  if (totalTokens === null) return null;

  return {
    totalTokens,
    inputTokens: asCount(record.inputTokens ?? record.input_tokens) ?? 0,
    outputTokens: asCount(record.outputTokens ?? record.output_tokens) ?? 0,
    cachedInputTokens: asCount(record.cachedInputTokens ?? record.cached_input_tokens) ?? 0,
    reasoningOutputTokens:
      asCount(record.reasoningOutputTokens ?? record.reasoning_output_tokens) ?? 0,
  };
}

function parseCodexContextUsage(data: JsonRecord): SessionContextUsage | null {
  const method = asString(data.method);
  if (!method || normalizeItemType(method) !== normalizeItemType('thread/tokenUsage/updated')) {
    return null;
  }

  const params = isRecord(data.params) ? data.params : null;
  if (!params) return null;

  const usage = isRecord(params.tokenUsage)
    ? params.tokenUsage
    : isRecord(params.token_usage)
      ? params.token_usage
      : null;
  if (!usage) return null;

  const total = readTokenBreakdown(usage.total ?? usage.total_token_usage);
  if (!total) return null;
  const last =
    readTokenBreakdown(usage.last ?? usage.last_token_usage) ??
    total;

  const maxTokens = asCount(usage.modelContextWindow ?? usage.model_context_window);
  const usagePercent = maxTokens && maxTokens > 0
    ? Math.min(100, (total.totalTokens / maxTokens) * 100)
    : null;

  return {
    usedTokens: total.totalTokens,
    maxTokens,
    usagePercent,
    totalInputTokens: total.inputTokens,
    totalOutputTokens: total.outputTokens,
    totalCachedInputTokens: total.cachedInputTokens,
    totalReasoningOutputTokens: total.reasoningOutputTokens,
    lastTotalTokens: last.totalTokens,
    updatedAt: Date.now(),
  };
}

interface ClaudeToolBlock {
  name: string;
  inputJson: string;
  index: number;
}

interface SessionContextUsage {
  usedTokens: number;
  maxTokens: number | null;
  usagePercent: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalReasoningOutputTokens: number;
  lastTotalTokens: number;
  updatedAt: number;
}

interface AppStore {
  // ─── State ───
  projects: Project[];
  sessions: Session[];
  sessionsByProject: Record<string, Session[]>;
  expandedProjects: Record<string, boolean>;
  sidebarWidth: number;
  activeProjectId: string | null;
  activeSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  queuedMessages: Record<string, string[]>;
  refreshingSessions: Record<string, boolean>;
  liveStatusBySession: Record<string, string>;
  contextUsageBySession: Record<string, SessionContextUsage>;
  activeTurnStartedAt: Record<string, number>;
  claudeToolBlocks: Record<string, ClaudeToolBlock>;
  settings: AppSettings;
  isSending: boolean;
  showSettings: boolean;
  showNewProjectDialog: boolean;
  showNewSessionDialog: boolean;
  sidebarCollapsed: boolean;
  showGitPanel: boolean;

  // ─── Actions ───
  initialize: () => Promise<void>;
  loadProjects: () => Promise<void>;
  addProject: (name: string, path: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  renameProject: (projectId: string, newName: string) => Promise<void>;
  setActiveProject: (projectId: string | null) => Promise<void>;

  loadSessions: (projectId: string) => Promise<void>;
  loadAllSessions: () => Promise<void>;
  createSession: (projectId: string, provider: AIProvider, name?: string) => Promise<void>;
  removeSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, newName: string) => Promise<void>;
  setSessionModel: (sessionId: string, model: string | null) => Promise<void>;
  setActiveSession: (sessionId: string | null) => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;
  toggleProjectExpanded: (projectId: string) => void;
  setSidebarWidth: (width: number) => void;

  loadMessages: (sessionId: string) => Promise<void>;
  refreshSession: (sessionId: string) => Promise<void>;
  sendMessageToSession: (sessionId: string, content: string) => Promise<void>;
  flushQueuedMessages: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  handleSessionEvent: (event: SessionEvent) => void;

  loadSettings: () => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<void>;

  setShowSettings: (show: boolean) => void;
  setShowNewProjectDialog: (show: boolean) => void;
  setShowNewSessionDialog: (show: boolean) => void;
  toggleSidebar: () => void;
  setShowGitPanel: (show: boolean) => void;
  toggleGitPanel: () => void;
}

function loadPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch { /* ignore */ }
  return fallback;
}

function savePersisted(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function normalizeSettings(settings: AppSettings): AppSettings {
  const clampedTransparency = Number.isFinite(settings.window_transparency)
    ? Math.max(0, Math.min(100, Math.round(settings.window_transparency)))
    : DEFAULT_WINDOW_TRANSPARENCY;

  const claudePermissionMode = normalizeClaudePermissionMode(settings.claude_permission_mode);

  return {
    ...settings,
    claude_permission_mode: claudePermissionMode,
    window_transparency: clampedTransparency,
  };
}

function normalizeClaudePermissionMode(mode: unknown): ClaudePermissionMode {
  switch (mode) {
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'default':
    case 'dontAsk':
    case 'plan':
      return mode;
    default:
      return DEFAULT_CLAUDE_PERMISSION_MODE;
  }
}

export const useAppStore = create<AppStore>((set, get) => ({
  // ─── Initial State ───
  projects: [],
  sessions: [],
  sessionsByProject: {},
  expandedProjects: loadPersisted<Record<string, boolean>>('expandedProjects', {}),
  sidebarWidth: loadPersisted<number>('sidebarWidth', 260),
  activeProjectId: null,
  activeSessionId: null,
  messages: {},
  queuedMessages: {},
  refreshingSessions: {},
  liveStatusBySession: {},
  contextUsageBySession: {},
  activeTurnStartedAt: {},
  claudeToolBlocks: {},
  settings: {
    codex_bin: null,
    claude_bin: null,
    claude_permission_mode: DEFAULT_CLAUDE_PERMISSION_MODE,
    theme: 'light',
    language: 'system',
    window_transparency: DEFAULT_WINDOW_TRANSPARENCY,
  },
  isSending: false,
  showSettings: false,
  showNewProjectDialog: false,
  showNewSessionDialog: false,
  sidebarCollapsed: false,
  showGitPanel: loadPersisted<boolean>('showGitPanel', true),

  // ─── Initialize ───
  initialize: async () => {
    try {
      await get().loadSettings();
      await get().loadProjects();
    } catch (e) {
      console.error('Failed to initialize:', e);
    }
  },

  // ─── Project Actions ───
  loadProjects: async () => {
    try {
      const projects = await api.listProjects();
      const currentActive = get().activeProjectId;
      const hasCurrentActive = currentActive
        ? projects.some((project) => project.id === currentActive)
        : false;
      const nextActiveProjectId = hasCurrentActive
        ? currentActive
        : (projects[0]?.id ?? null);

      set({
        projects,
        activeProjectId: nextActiveProjectId,
        activeSessionId: null,
        sessions: [],
      });

      await get().loadAllSessions();

      if (nextActiveProjectId) {
        await get().loadSessions(nextActiveProjectId);
      }
    } catch (e) {
      console.error('Failed to load projects:', e);
    }
  },

  addProject: async (name: string, path: string) => {
    try {
      const project = await api.addProject(name, path);
      set((state) => ({ projects: [...state.projects, project] }));
      await get().setActiveProject(project.id);
    } catch (e) {
      console.error('Failed to add project:', e);
      throw e;
    }
  },

  removeProject: async (projectId: string) => {
    try {
      await api.removeProject(projectId);
      set((state) => {
        const projects = state.projects.filter((p) => p.id !== projectId);
        const activeProjectId =
          state.activeProjectId === projectId ? null : state.activeProjectId;
        const sessionsByProject = { ...state.sessionsByProject };
        delete sessionsByProject[projectId];
        const expandedProjects = { ...state.expandedProjects };
        delete expandedProjects[projectId];
        savePersisted('expandedProjects', expandedProjects);
        return { projects, activeProjectId, sessions: activeProjectId ? state.sessions : [], sessionsByProject, expandedProjects };
      });
    } catch (e) {
      console.error('Failed to remove project:', e);
    }
  },

  renameProject: async (projectId: string, newName: string) => {
    try {
      await api.renameProject(projectId, newName);
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === projectId ? { ...p, name: newName } : p
        ),
      }));
    } catch (e) {
      console.error('Failed to rename project:', e);
    }
  },

  setActiveProject: async (projectId: string | null) => {
    set((state) => {
      const expandedProjects = projectId
        ? { ...state.expandedProjects, [projectId]: true }
        : state.expandedProjects;
      savePersisted('expandedProjects', expandedProjects);
      return { activeProjectId: projectId, activeSessionId: null, sessions: [], expandedProjects };
    });
    if (projectId) {
      await get().loadSessions(projectId);
    }
  },

  // ─── Session Actions ───
  loadSessions: async (projectId: string) => {
    try {
      const sessions = await api.listSessions(projectId);
      set((state) => ({
        sessions,
        sessionsByProject: { ...state.sessionsByProject, [projectId]: sessions },
      }));
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  },

  loadAllSessions: async () => {
    try {
      const allSessions = await api.getAllSessions();
      const grouped: Record<string, Session[]> = {};
      for (const s of allSessions) {
        if (!grouped[s.project_id]) grouped[s.project_id] = [];
        grouped[s.project_id].push(s);
      }
      set({ sessionsByProject: grouped });
    } catch (e) {
      console.error('Failed to load all sessions:', e);
    }
  },

  createSession: async (projectId: string, provider: AIProvider, name?: string) => {
    try {
      const session = await api.createSession(projectId, provider, name);
      set((state) => ({
        sessions: [...state.sessions, session],
        sessionsByProject: {
          ...state.sessionsByProject,
          [projectId]: [...(state.sessionsByProject[projectId] || []), session],
        },
      }));
      await get().setActiveSession(session.id);
    } catch (e) {
      console.error('Failed to create session:', e);
      throw e;
    }
  },

  removeSession: async (sessionId: string) => {
    try {
      await api.removeSession(sessionId);
      set((state) => {
        const sessions = state.sessions.filter((s) => s.id !== sessionId);
        const activeSessionId =
          state.activeSessionId === sessionId ? null : state.activeSessionId;
        const sessionsByProject = { ...state.sessionsByProject };
        for (const pid of Object.keys(sessionsByProject)) {
          sessionsByProject[pid] = sessionsByProject[pid].filter((s) => s.id !== sessionId);
        }
        const contextUsageBySession = { ...state.contextUsageBySession };
        delete contextUsageBySession[sessionId];
        return { sessions, activeSessionId, sessionsByProject, contextUsageBySession };
      });
    } catch (e) {
      console.error('Failed to remove session:', e);
    }
  },

  renameSession: async (sessionId: string, newName: string) => {
    try {
      await api.renameSession(sessionId, newName);
      const mapName = (s: Session) => s.id === sessionId ? { ...s, name: newName } : s;
      set((state) => {
        const sessionsByProject = { ...state.sessionsByProject };
        for (const pid of Object.keys(sessionsByProject)) {
          sessionsByProject[pid] = sessionsByProject[pid].map(mapName);
        }
        return {
          sessions: state.sessions.map(mapName),
          sessionsByProject,
        };
      });
    } catch (e) {
      console.error('Failed to rename session:', e);
    }
  },

  setSessionModel: async (sessionId: string, model: string | null) => {
    const normalized = model && model.trim().length > 0 ? model.trim() : null;
    try {
      await api.updateSessionModel(sessionId, normalized);
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, model: normalized, updated_at: Date.now() } : s
        ),
      }));
    } catch (e) {
      console.error('Failed to update session model:', e);
      throw e;
    }
  },

  setActiveSession: async (sessionId: string | null) => {
    set({ activeSessionId: sessionId });
    if (sessionId) {
      await get().loadMessages(sessionId);
    }
  },

  stopSession: async (sessionId: string) => {
    try {
      await api.stopSession(sessionId);
    set({ isSending: false });
    set((state) => {
      const nextStatus = { ...state.liveStatusBySession };
      const nextStart = { ...state.activeTurnStartedAt };
      delete nextStatus[sessionId];
      delete nextStart[sessionId];
      return {
        liveStatusBySession: nextStatus,
        activeTurnStartedAt: nextStart,
      };
    });
    void get().flushQueuedMessages(sessionId);
    } catch (e) {
      console.error('Failed to stop session:', e);
    }
  },

  // ─── Message Actions ───
  loadMessages: async (sessionId: string) => {
    try {
      const messages = await api.getMessages(sessionId);
      set((state) => ({
        messages: { ...state.messages, [sessionId]: messages },
      }));
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  },

  refreshSession: async (sessionId: string) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session) return;

    set((state) => ({
      refreshingSessions: {
        ...state.refreshingSessions,
        [sessionId]: true,
      },
    }));

    try {
      await get().loadSessions(session.project_id);
      const messages = await api.getMessages(sessionId);
      set((state) => ({
        messages: { ...state.messages, [sessionId]: messages },
      }));
    } catch (e) {
      console.error('Failed to refresh session:', e);
    } finally {
      set((state) => {
        const next = { ...state.refreshingSessions };
        delete next[sessionId];
        return { refreshingSessions: next };
      });
    }
  },

  sendMessageToSession: async (sessionId: string, content: string) => {
    const trimmed = content.trim();
    if (!sessionId || !trimmed) return;

    if (get().isSending) {
      set((state) => {
        const existing = state.queuedMessages[sessionId] || [];
        return {
          queuedMessages: {
            ...state.queuedMessages,
            [sessionId]: [...existing, trimmed],
          },
        };
      });
      return;
    }

    set({ isSending: true });
    set((state) => ({
      liveStatusBySession: {
        ...state.liveStatusBySession,
        [sessionId]: 'Thinking',
      },
      activeTurnStartedAt: {
        ...state.activeTurnStartedAt,
        [sessionId]: Date.now(),
      },
    }));
    try {
      await api.sendMessage(sessionId, trimmed);
    } catch (e) {
      console.error('Failed to send message:', e);
      set({ isSending: false });
      const errorMsg = formatErrorMessage(e);
      set((state) => {
        const nextStatus = { ...state.liveStatusBySession };
        const nextStart = { ...state.activeTurnStartedAt };
        const existing = state.messages[sessionId] || [];
        const updated = mergeMessage(existing, sessionId, {
          role: 'system',
          messageType: 'error',
          content: errorMsg,
          mode: 'new',
        });
        delete nextStatus[sessionId];
        delete nextStart[sessionId];
        return {
          liveStatusBySession: nextStatus,
          activeTurnStartedAt: nextStart,
          messages: updated === existing ? state.messages : { ...state.messages, [sessionId]: updated },
        };
      });
    }
  },

  flushQueuedMessages: async (sessionId: string) => {
    if (!sessionId || get().isSending) return;

    const queue = get().queuedMessages[sessionId] || [];
    if (queue.length === 0) return;

    const [next, ...rest] = queue;
    set((state) => {
      const updated = { ...state.queuedMessages };
      if (rest.length > 0) {
        updated[sessionId] = rest;
      } else {
        delete updated[sessionId];
      }
      return { queuedMessages: updated };
    });

    await get().sendMessageToSession(sessionId, next);
  },

  sendMessage: async (content: string) => {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    await get().sendMessageToSession(activeSessionId, content);
  },

  handleSessionEvent: (event: SessionEvent) => {
    const { session_id, event_type, data } = event;

    if (event_type === 'user_message') {
      const msg = data as unknown as ChatMessage;
      set((state) => {
        const existing = state.messages[session_id] || [];
        // Avoid duplicates
        if (existing.some((m) => m.id === msg.id)) return state;
        return {
          messages: { ...state.messages, [session_id]: [...existing, msg] },
        };
      });
      return;
    }

    if (event_type === 'assistant_message') {
      const msg = data as unknown as ChatMessage;
      set((state) => {
        const existing = state.messages[session_id] || [];
        if (existing.some((m) => m.id === msg.id)) return state;
        return {
          messages: { ...state.messages, [session_id]: [...existing, msg] },
        };
      });
      return;
    }

    if (event_type === 'session_renamed') {
      const newName = asString(data.name);
      if (!newName) return;

      const mapName = (s: Session) => s.id === session_id ? { ...s, name: newName } : s;
      set((state) => {
        const sessionsByProject = { ...state.sessionsByProject };
        for (const pid of Object.keys(sessionsByProject)) {
          sessionsByProject[pid] = sessionsByProject[pid].map(mapName);
        }
        return {
          sessions: state.sessions.map(mapName),
          sessionsByProject,
        };
      });
      return;
    }

    if (event_type === 'codex_message') {
      const contextUsage = parseCodexContextUsage(data);
      if (contextUsage) {
        set((state) => ({
          contextUsageBySession: {
            ...state.contextUsageBySession,
            [session_id]: contextUsage,
          },
        }));
      }

      const method = asString((data as JsonRecord).method);
      if (method === 'turn/completed') {
        set({ isSending: false });
        set((state) => {
          const nextStatus = { ...state.liveStatusBySession };
          const nextStart = { ...state.activeTurnStartedAt };
          delete nextStatus[session_id];
          delete nextStart[session_id];
          return {
            liveStatusBySession: nextStatus,
            activeTurnStartedAt: nextStart,
          };
        });
        void get().flushQueuedMessages(session_id);
      }

      const status = parseCodexLiveStatus(data);
      if (typeof status === 'string' && status.trim()) {
        set((state) => ({
          liveStatusBySession: {
            ...state.liveStatusBySession,
            [session_id]: status,
          },
        }));
      } else if (status === null) {
        set((state) => {
          const nextStatus = { ...state.liveStatusBySession };
          delete nextStatus[session_id];
          return { liveStatusBySession: nextStatus };
        });
      }

      const parsed = parseCodexEvent(data);
      if (!parsed) return;

      set((state) => {
        const existing = state.messages[session_id] || [];
        const updated = mergeMessage(existing, session_id, parsed);
        if (updated === existing) return state;
        return { messages: { ...state.messages, [session_id]: updated } };
      });
      return;
    }

    if (event_type === 'claude_stream' || event_type === 'claude_message') {
      const status = parseClaudeLiveStatus(data);
      if (typeof status === 'string' && status.trim()) {
        set((state) => ({
          liveStatusBySession: { ...state.liveStatusBySession, [session_id]: status },
        }));
      } else if (status === null) {
        set((state) => {
          const nextStatus = { ...state.liveStatusBySession };
          delete nextStatus[session_id];
          return { liveStatusBySession: nextStatus };
        });
      }

      if (event_type === 'claude_stream') {
        const evt = isRecord(data.event) ? data.event : null;
        if (!evt) return;

        const evtType = asString(evt.type);
        if (!evtType) return;

        if (evtType === 'content_block_start') {
          const contentBlock = isRecord(evt.content_block) ? evt.content_block : null;
          if (contentBlock && contentBlock.type === 'tool_use') {
            const toolName = asString(contentBlock.name) || 'Tool';
            const index = asNumber(evt.index) ?? 0;
            set((state) => ({
              claudeToolBlocks: {
                ...state.claudeToolBlocks,
                [session_id]: { name: toolName, inputJson: '', index },
              },
            }));
          }
          return;
        }

        if (evtType === 'content_block_delta') {
          const delta = isRecord(evt.delta) ? evt.delta : null;
          if (!delta) return;

          if (delta.type === 'input_json_delta') {
            const partialJson = asString(delta.partial_json) || '';
            if (partialJson) {
              set((state) => {
                const block = state.claudeToolBlocks[session_id];
                if (!block) return state;
                return {
                  claudeToolBlocks: {
                    ...state.claudeToolBlocks,
                    [session_id]: { ...block, inputJson: block.inputJson + partialJson },
                  },
                };
              });
            }
            return;
          }

          if (delta.type === 'text_delta') {
            const text = asString(delta.text);
            if (!text) return;
            set((state) => {
              const existing = state.messages[session_id] || [];
              const updated = mergeMessage(existing, session_id, {
                role: 'assistant',
                messageType: 'text',
                content: text,
                mode: 'append',
              });
              if (updated === existing) return state;
              return {
                messages: { ...state.messages, [session_id]: updated },
              };
            });
            return;
          }

          if (delta.type === 'thinking_delta') {
            const thinking = firstNonEmptyString([delta.thinking, delta.text]);
            if (!thinking) return;
            set((state) => {
              const existing = state.messages[session_id] || [];
              const updated = mergeMessage(existing, session_id, {
                role: 'assistant',
                messageType: 'reasoning',
                content: thinking,
                mode: 'append',
              });
              if (updated === existing) return state;
              return {
                messages: { ...state.messages, [session_id]: updated },
              };
            });
            return;
          }

          return;
        }

        if (evtType === 'content_block_stop') {
          const block = get().claudeToolBlocks[session_id];
          if (!block) return;

          let input: JsonRecord = {};
          try { input = JSON.parse(block.inputJson || '{}') as JsonRecord; } catch { /* ignore */ }

          const content = formatClaudeToolMessage(block.name, input);

          set((state) => {
            const nextBlocks = { ...state.claudeToolBlocks };
            delete nextBlocks[session_id];

            const existing = state.messages[session_id] || [];
            const updated = mergeMessage(existing, session_id, {
              role: 'assistant',
              messageType: 'tool',
              content,
              mode: 'new',
            });

            return {
              claudeToolBlocks: nextBlocks,
              messages: updated === existing ? state.messages : { ...state.messages, [session_id]: updated },
            };
          });
          return;
        }

        return;
      }

      const parsedClaudeMessages = parseClaudeMessage(data);
      if (parsedClaudeMessages.length === 0) return;

      set((state) => {
        const existing = state.messages[session_id] || [];
        let next = existing;
        for (const parsed of parsedClaudeMessages) {
          next = mergeMessage(next, session_id, parsed);
        }
        if (next === existing) return state;
        return { messages: { ...state.messages, [session_id]: next } };
      });
      return;
    }

    if (event_type === 'gemini_stream') {
      const status = parseGeminiLiveStatus(data);
      if (typeof status === 'string' && status.trim()) {
        set((state) => ({
          liveStatusBySession: { ...state.liveStatusBySession, [session_id]: status },
        }));
      } else if (status === null) {
        set((state) => {
          const nextStatus = { ...state.liveStatusBySession };
          delete nextStatus[session_id];
          return { liveStatusBySession: nextStatus };
        });
      }

      const delta = asString(data.delta);
      if (!delta) return;

      set((state) => {
        const existing = state.messages[session_id] || [];
        const updated = mergeMessage(existing, session_id, {
          role: 'assistant',
          messageType: 'text',
          content: delta,
          mode: 'append',
        });
        if (updated === existing) return state;
        return { messages: { ...state.messages, [session_id]: updated } };
      });
      return;
    }

    if (event_type === 'gemini_result') {
      set({ isSending: false });
      set((state) => {
        const nextStatus = { ...state.liveStatusBySession };
        const nextStart = { ...state.activeTurnStartedAt };
        delete nextStatus[session_id];
        delete nextStart[session_id];
        return {
          liveStatusBySession: nextStatus,
          activeTurnStartedAt: nextStart,
        };
      });
      void get().flushQueuedMessages(session_id);

      const result = asString(data.result) || '';
      if (result) {
        set((state) => {
          const existing = state.messages[session_id] || [];
          const updated = mergeMessage(existing, session_id, {
            role: 'assistant',
            messageType: 'text',
            content: result,
            mode: 'replace_or_create',
          });
          if (updated === existing) return state;
          return {
            messages: { ...state.messages, [session_id]: updated },
          };
        });
      }
      return;
    }

    // Handle Claude result (final message)
    if (event_type === 'claude_result') {
      set({ isSending: false });
      set((state) => {
        const nextStatus = { ...state.liveStatusBySession };
        const nextStart = { ...state.activeTurnStartedAt };
        const nextBlocks = { ...state.claudeToolBlocks };
        delete nextStatus[session_id];
        delete nextStart[session_id];
        delete nextBlocks[session_id];
        return {
          liveStatusBySession: nextStatus,
          activeTurnStartedAt: nextStart,
          claudeToolBlocks: nextBlocks,
        };
      });
      void get().flushQueuedMessages(session_id);

      // Save provider_session_id from Claude result for --resume and session sync
      const providerSid = asString(data.session_id);
      if (providerSid) {
        const session = get().sessions.find((s) => s.id === session_id);
        if (session && !session.provider_session_id) {
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === session_id ? { ...s, provider_session_id: providerSid } : s
            ),
          }));
          void api.saveProviderSessionId(session_id, providerSid);
        }
      }

      const result = asString(data.result) || '';
      if (result) {
        set((state) => {
          const existing = state.messages[session_id] || [];
          const updated = mergeMessage(existing, session_id, {
            role: 'assistant',
            messageType: 'text',
            content: result,
            mode: 'replace_or_create',
          });
          if (updated === existing) return state;
          return {
            messages: { ...state.messages, [session_id]: updated },
          };
        });
      }
      return;
    }

    // Handle errors
    if (event_type === 'codex_error' || event_type === 'claude_error' || event_type === 'gemini_error') {
      set({ isSending: false });
      set((state) => {
        const nextStatus = { ...state.liveStatusBySession };
        const nextStart = { ...state.activeTurnStartedAt };
        const nextBlocks = { ...state.claudeToolBlocks };
        delete nextStatus[session_id];
        delete nextStart[session_id];
        delete nextBlocks[session_id];
        return {
          liveStatusBySession: nextStatus,
          activeTurnStartedAt: nextStart,
          claudeToolBlocks: nextBlocks,
        };
      });
      void get().flushQueuedMessages(session_id);

      const errorMsg = asString(data.message) || 'Unknown error';
      set((state) => {
        const existing = state.messages[session_id] || [];
        const updated = mergeMessage(existing, session_id, {
          role: 'system',
          messageType: 'error',
          content: errorMsg,
          mode: 'new',
        });
        return {
          messages: { ...state.messages, [session_id]: updated },
        };
      });
      return;
    }
  },

  // ─── Settings Actions ───
  loadSettings: async () => {
    try {
      const settings = normalizeSettings(await api.getSettings());
      set({ settings });
      setLanguage(settings.language || 'system');
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  },

  updateSettings: async (settings: AppSettings) => {
    try {
      const normalized = normalizeSettings(settings);
      await api.updateSettings(normalized);
      set({ settings: normalized });
      setLanguage(normalized.language || 'system');
    } catch (e) {
      console.error('Failed to update settings:', e);
      throw e;
    }
  },

  toggleProjectExpanded: (projectId: string) => {
    set((state) => {
      const expandedProjects = {
        ...state.expandedProjects,
        [projectId]: !state.expandedProjects[projectId],
      };
      savePersisted('expandedProjects', expandedProjects);
      return { expandedProjects };
    });
  },

  setSidebarWidth: (width: number) => {
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
    // Keep main content usable when sidebar is expanded.
    const maxByViewport = Math.max(200, viewportWidth - 620);
    const clamped = Math.max(200, Math.min(width, 500, maxByViewport));
    savePersisted('sidebarWidth', clamped);
    set({ sidebarWidth: clamped });
  },

  // ─── UI Actions ───
  setShowSettings: (show: boolean) => set({ showSettings: show }),
  setShowNewProjectDialog: (show: boolean) => set({ showNewProjectDialog: show }),
  setShowNewSessionDialog: (show: boolean) => set({ showNewSessionDialog: show }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setShowGitPanel: (show: boolean) => {
    savePersisted('showGitPanel', show);
    set({ showGitPanel: show });
  },
  toggleGitPanel: () => set((state) => {
    const next = !state.showGitPanel;
    savePersisted('showGitPanel', next);
    return { showGitPanel: next };
  }),
}));
