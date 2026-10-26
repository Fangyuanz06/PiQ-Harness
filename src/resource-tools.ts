import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Conversation } from './conversations.ts';
import type { SnowLumaTransport } from './transport.ts';

export type ResourceRequest = (action: string, params: Record<string, unknown>, mutating?: boolean) => Promise<unknown>;

export interface ResourceContext {
  cwd: string;
  conversation: Conversation;
  signal: AbortSignal;
  transport: SnowLumaTransport;
}

export type ResolveResourceContext = (ctx: ExtensionContext, conversation: string, signal?: AbortSignal) => ResourceContext;
