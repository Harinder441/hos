export const SNAG_KINDS = ['question', 'fix', 'context'] as const;
export type SnagKind = (typeof SNAG_KINDS)[number];
export const SNAG_KIND_LABELS: Record<SnagKind, string> = { fix: 'Fix', question: 'Question', context: 'Context' };
// A resolved snag records how it was closed: fixed (resolved, needs a commit ref in the note), wontfix, or
// not-reproduced. snag_resolve refuses a bare "resolved" with no commit ref so every fix is traceable (H9).
export const RESOLVED_STATES = ['resolved', 'wontfix', 'not-reproduced'] as const;
export type ResolvedState = (typeof RESOLVED_STATES)[number];
export type SnagState = 'open' | ResolvedState;
export type SnagFilter = SnagState | 'all';

export interface SnagFile {
  name: string;
  path: string;
}

export interface SnagLink {
  topicId: string;
  chatId: string;
  at: number;
}

export type CommentAuthor = 'claude' | 'user';

export interface SnagComment {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: number;
}

export interface Snag {
  id: number;
  ref: string;
  kind: SnagKind;
  text: string;
  files: SnagFile[];
  state: SnagState;
  createdAt: number;
  createdBy: string;
  from: string | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  note: string | null;
  links: SnagLink[];
  context: string | null;
  comments: SnagComment[];
  lastCommentAuthor: CommentAuthor | null;
}

export interface SnagSummary {
  open: number;
  openContext: number;
  total: number;
  label: string;
  offline: boolean;
  queued: number;
}

export interface NewSnag {
  kind: SnagKind;
  text: string;
  files?: Array<{ name: string; data: string }>;
  topicId?: string;
  chatId?: string;
}
