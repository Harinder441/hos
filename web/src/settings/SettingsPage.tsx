import { useEffect, useState, type FormEvent } from 'react';
import type { SettingsPage as Page, SettingsSection, StatusItem } from '../../../src/api/types.js';
import { ConfigPage } from '../config/ConfigPage.js';
import { client, errorText } from '../lib.js';
import { startTopic } from '../model/index.js';
import { bySeverity, StatusList } from '../Ops.js';
import { SchedulesPage } from '../schedules/SchedulesPage.js';
import { HARNESS_GUIDE } from '../setup/FirstRun.js';
import { IconButton } from '../shell/icons.js';
import { useShell } from '../shell/Layout.js';
import { Notifications } from '../shell/Notifications.js';
import { topicHref } from '../shell/routes.js';
import type { State } from '../state.js';
import { useOwner } from '../topic/catalog.js';
import '../styles/settings.css';
import { Computers } from './Computers.js';
import { Projects } from './Projects.js';

const IDS = ['doctor', 'projects', 'agents', 'profiles', 'approvals', 'workspaces', 'schedules', 'remote', 'computers', 'storage', 'advanced'];
const TITLES = ['Doctor', 'Projects', 'Models & agents', 'Profiles', 'Approvals', 'Workspaces', 'Schedules', 'Phone & remote access', 'Computers', 'Storage & integrations', 'Advanced'];
const UI_ONLY = ['schedules', 'computers'];
const MOVED: Record<string, string> = {
  models: 'agents',
  limits: 'agents',
  composer: 'advanced',
  context: 'advanced',
  actions: 'workspaces',
  'workspace-rules': 'workspaces',
  config: 'workspaces',
  connection: 'remote',
  notifications: 'remote',
  setup: 'doctor',
};

export function settingsRequest(words: string, owner: string | null, validate: string): string {
  return [
    `Settings: ${words}`,
    '',
    `${owner ?? 'The user'} asked for this on the hos Settings page. Make the change in the brain’s hos/*.yaml (policy.yaml, actions.yaml or workspace-rules.yaml).`,
    `Keep every existing comment, give any key you add a one-line comment saying why, then run \`${validate}\` and fix whatever it reports.`,
    'hos reloads policy.yaml by itself; a transport or port change needs a daemon restart, so say so if you make one. Reply with what changed.',
  ].join('\n');
}

export function SettingsPage({ state, tab }: { state: State; tab?: string }) {
  const shell = useShell();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState<string>();
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const [askError, setAskError] = useState<string>();
  const owner = useOwner();
  useEffect(() => {
    const load = () => void client.settings().then(setPage, (e: unknown) => setError(errorText(e)));
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  const wanted = tab ? (MOVED[tab] ?? tab) : undefined;
  useEffect(() => {
    if (tab && MOVED[tab]) location.replace(`#/settings/${MOVED[tab]}`);
  }, [tab]);
  const sections: SettingsSection[] = IDS.map((id, i) => page?.sections.find((s) => s.id === id) ?? { id, title: TITLES[i]!, file: null, settings: [] });
  const active = sections.find((s) => s.id === wanted) ?? sections[0]!;
  const asks = !UI_ONLY.includes(active.id);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const words = ask.trim();
    if (!words || busy) return;
    setBusy(true);
    setAskError(undefined);
    try {
      const validate = (page ?? (await client.settings())).validate;
      const { topicId, chatId } = await startTopic(settingsRequest(words, owner?.name ?? null, validate), {});
      location.hash = topicHref(topicId, chatId);
    } catch (err) {
      setAskError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <>
      <header className="topbar">
        <IconButton className="icon-btn menu-btn" icon="i-menu" label="Open navigation" tip="Open the sidebar" onClick={shell.openSide} />
        <h1>Settings</h1>
      </header>
      <div className="settings-body">
        {asks && (
          <>
            <form className="settings-ask" onSubmit={send}>
              <input
                aria-label="Ask to change a setting"
                placeholder="Ask to change a setting…"
                value={ask}
                disabled={busy}
                onChange={(e) => {
                  setAsk(e.target.value);
                  setAskError(undefined);
                }}
              />
              <IconButton type="submit" className="icon-btn settings-send" icon="i-send" label="Send" tip="Ask hos to change settings" disabled={busy || !ask.trim()} />
            </form>
            <p className="settings-hint muted">Read-only here. A message starts a topic whose chat edits your brain’s settings files; most changes apply without a restart.</p>
          </>
        )}
        {askError && <p className="error-text">{askError}</p>}
        {error && <p className="error-text">{error}</p>}
        <div className="settings-split">
          <nav className="settings-nav" aria-label="Settings sections">
            <ul role="tablist" aria-orientation="vertical">
              {sections.map((s, i) => (
                <li key={s.id} role="presentation">
                  <button type="button" role="tab" aria-selected={s.id === active.id} aria-controls="settings-panel" onClick={() => (location.hash = `#/settings/${s.id}`)}>
                    <span className="settings-n" aria-hidden="true">
                      {i + 1}
                    </span>
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <section id="settings-panel" className="settings-panel" role="tabpanel" aria-label={active.title}>
            <div className="settings-head">
              <h2>{active.title}</h2>
              {active.file && <code className="settings-file">{active.file}</code>}
            </div>
            {active.what && <p className="settings-what">{active.what}</p>}
            {active.note && <p className="settings-note">{active.note}</p>}
            <Widget id={active.id} state={state} />
            {!page && !UI_ONLY.includes(active.id) ? <p className="muted">Loading…</p> : <Rows section={active} />}
          </section>
        </div>
      </div>
    </>
  );
}

function Widget({ id, state }: { id: string; state: State }) {
  switch (id) {
    case 'doctor':
      return <DoctorChecks />;
    case 'projects':
      return <Projects state={state} />;
    case 'agents':
      return (
        <div className="settings-addh">
          <strong>Add a harness</strong>
          <span className="settings-desc">Run another coding agent in hos: one driven through its SDK, or any agent that speaks ACP (Agent Client Protocol).</span>
          <a href={HARNESS_GUIDE} target="_blank" rel="noreferrer">
            Read the guide
          </a>
        </div>
      );
    case 'workspaces':
      return (
        <>
          <h3 className="settings-sub">Environment files</h3>
          <p className="settings-desc">.env files that git doesn’t track. hos keeps a copy and puts it in every new worktree of that repo.</p>
          <ConfigPage state={state} />
          <h3 className="settings-sub">Actions and rules</h3>
        </>
      );
    case 'schedules':
      return <SchedulesPage />;
    case 'remote':
      return (
        <div className="settings-notify">
          <h3 className="settings-sub">Notifications on this device</h3>
          <p className="settings-desc">This device only. The one setting you change here. Each browser turns notifications on by itself, and every subscribed browser gets every notification.</p>
          <Notifications details />
          <h3 className="settings-sub">How you reach this computer</h3>
        </div>
      );
    case 'computers':
      return <Computers />;
    default:
      return null;
  }
}

function Rows({ section }: { section: SettingsSection }) {
  if (section.settings.length === 0) return UI_ONLY.includes(section.id) ? null : <p className="muted">Nothing set in {section.file ?? 'the brain'}.</p>;
  return (
    <ul className="settings-list" aria-label={`${section.title} settings`}>
      {section.settings.map((setting, i) => (
        <li key={`${setting.key}-${i}`} className="settings-row" aria-label={setting.key}>
          <div className="settings-key">
            <span>{setting.key}</span>
            {setting.restart && <span className="tag">needs a restart</span>}
          </div>
          <code className="settings-value">{setting.value || '—'}</code>
          {setting.description && <p className="settings-desc">{setting.description}</p>}
        </li>
      ))}
    </ul>
  );
}

function DoctorChecks() {
  const [checks, setChecks] = useState<StatusItem[]>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setChecks(undefined);
    client.doctorChecks().then(setChecks, (e: unknown) => setError(errorText(e)));
  }, [tick]);
  return (
    <div className="settings-doctor">
      <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>
        Check again
      </button>
      {error && <p className="error-text">{error}</p>}
      {checks ? <StatusList label="Doctor" items={bySeverity(checks)} /> : <p className="muted">Checking this computer…</p>}
    </div>
  );
}
