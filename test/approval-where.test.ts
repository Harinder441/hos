import { expect, test } from 'vitest';
import type { Chat } from '../src/api/types.js';
import type { State } from '../web/src/state.js';
import { approvalWhere } from '../web/src/topic/where.js';

const WORKTREE = '/srv/alex/Repos/notes-web-worktrees/dark-mode';

const state = {
  topics: { t1: { workspaceIds: ['w1'] } },
  workspaces: { w1: { id: 'w1', projectId: 'p1', name: 'dark-mode', path: WORKTREE, branch: 'dark-mode' } },
  projects: [{ id: 'p1', name: 'notes-web' }],
} as unknown as State;
const chat = { topicId: 't1', worktreePath: null } as Chat;
const bash = (command: string) => JSON.stringify({ command, description: 'x' });

test('an approval card names the workspace a brain chat’s command runs in through a leading cd, and the brain otherwise', () => {
  expect(approvalWhere(state, chat, bash(`cd ${WORKTREE} && npm test`))).toBe('in notes-web, dark-mode');
  expect(approvalWhere(state, chat, bash(`cd "${WORKTREE}/web"; npm run build`))).toBe('in notes-web, dark-mode');
  expect(approvalWhere(state, chat, JSON.stringify({ file_path: `${WORKTREE}/src/app.ts` }))).toBe('in notes-web, dark-mode');
  expect(approvalWhere(state, chat, bash('npm test'))).toBe('in the brain');
  expect(approvalWhere(state, chat, bash(`echo cd ${WORKTREE}`))).toBe('in the brain');
  expect(approvalWhere(state, chat, bash('cd /tmp && ls'))).toBe('in the brain');
});
