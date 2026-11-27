import { useEffect, useState, type ReactNode } from 'react';
import type { FirstRunState, SettingsPage, StatusItem } from '../../../src/api/types.js';
import { client, useAction } from '../lib.js';
import { Projects } from '../settings/Projects.js';
import { Wordmark } from '../Sidebar.js';
import type { State } from '../state.js';
import '../styles/first-run.css';

export const FIRST_RUN_KEY = 'hos.first-run';
export const HARNESS_GUIDE = 'https://github.com/Harinder441/hos/blob/main/docs/site/src/content/docs/docs/add-a-harness.md';
const STEPS = ['You', 'Brain', 'Claude', 'Projects', 'Phone'] as const;
type Step = 'you' | 'brain' | 'claude' | 'projects' | 'phone' | 'done';
const ORDER: Step[] = ['you', 'brain', 'claude', 'projects', 'phone', 'done'];
const RESTART_WAIT_MS = 90_000;

const STARTER_PROMPTS = [
  'Look around my projects and tell me what each one is for, in one line each.',
  'Find the flakiest test in one of my projects and explain why it fails.',
  'Read my brain’s profiles and suggest one I should add for how I work.',
];

export function useFirstRun(): { active: boolean; setup: FirstRunState | null; finish(): void } {
  const [setup, setSetup] = useState<FirstRunState | null>(null);
  const [stored, setStored] = useState(() => localStorage.getItem(FIRST_RUN_KEY));
  useEffect(() => {
    void client.setup().then(
      (state) => {
        if (state.needed && !localStorage.getItem(FIRST_RUN_KEY)) {
          localStorage.setItem(FIRST_RUN_KEY, 'you');
          setStored('you');
        }
        setSetup(state);
      },
      () => setSetup({ needed: false }),
    );
  }, []);
  return {
    active: !!setup && !!stored,
    setup,
    finish: () => {
      localStorage.removeItem(FIRST_RUN_KEY);
      setStored(null);
    },
  };
}

export function Stepper({ step }: { step: number }) {
  return (
    <ol className="first-run-steps" aria-label="Setup steps">
      {STEPS.map((name, i) => (
        <li key={name} aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : i === step ? 'current' : ''}>
          <span className="first-run-n">{i + 1}</span> {name}
        </li>
      ))}
    </ol>
  );
}

function Screen({ step, title, lead, children }: { step: number; title: string; lead: string; children: ReactNode }) {
  return (
    <main className="first-run" aria-label="Set up hos">
      <div className="first-run-card">
        <h1>
          <Wordmark />
        </h1>
        {step < STEPS.length && <Stepper step={step} />}
        <h2>{title}</h2>
        <p className="lead">{lead}</p>
        {children}
      </div>
    </main>
  );
}

export function FirstRun({ state, setup, onDone }: { state: State; setup: FirstRunState | null; onDone(): void }) {
  const [step, setStep] = useState<Step>(() => (localStorage.getItem(FIRST_RUN_KEY) as Step | null) ?? 'you');
  const [owner, setOwner] = useState({ name: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const go = (next: Step) => {
    localStorage.setItem(FIRST_RUN_KEY, next);
    setStep(next);
  };
  const next = () => go(ORDER[ORDER.indexOf(step) + 1]!);
  const index = ORDER.indexOf(step) === -1 ? 0 : ORDER.indexOf(step);
  switch (step) {
    case 'you':
      return <You owner={owner} onChange={setOwner} onNext={next} />;
    case 'brain':
      return <Brain setup={setup} owner={owner} index={index} onNext={next} />;
    case 'claude':
      return <Claude onNext={next} />;
    case 'projects':
      return <ProjectsStep state={state} onNext={next} />;
    case 'phone':
      return <Phone onNext={next} />;
    default:
      return <Done onDone={onDone} />;
  }
}

function You({ owner, onChange, onNext }: { owner: { name: string; timezone: string }; onChange(owner: { name: string; timezone: string }): void; onNext(): void }) {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return (
    <Screen step={0} title="About you" lead="Your passkey is saved. Two things chats use when they talk to you and when they plan your day.">
      <label>
        <span className="field-label">What should chats call you?</span>
        <input value={owner.name} maxLength={60} autoComplete="given-name" placeholder="Leave empty and chats say “you”" onChange={(e) => onChange({ ...owner, name: e.target.value })} />
      </label>
      <label>
        <span className="field-label">Time zone</span>
        <input value={owner.timezone} list="first-run-zones" spellCheck={false} onChange={(e) => onChange({ ...owner, timezone: e.target.value })} />
        <datalist id="first-run-zones">
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </label>
      <p className="hint">Used for schedules, dates and history lines. It starts as this computer’s zone.</p>
      <button type="button" className="primary" onClick={onNext}>
        Continue
      </button>
    </Screen>
  );
}

function Brain({ setup, owner, index, onNext }: { setup: FirstRunState | null; owner: { name: string; timezone: string }; index: number; onNext(): void }) {
  const ready = setup?.needed ? setup : null;
  const [from, setFrom] = useState<'starter' | 'existing' | 'clone'>('starter');
  const [path, setPath] = useState(ready?.defaultBrain ?? '');
  const [url, setUrl] = useState('');
  const [remote, setRemote] = useState('');
  const [phase, setPhase] = useState<'form' | 'restarting'>('form');
  const { error, busy, run } = useAction();
  useEffect(() => {
    if (ready && !path) setPath(ready.defaultBrain);
  }, [ready]);
  if (!ready && phase === 'form') {
    return (
      <Screen step={index} title="Your brain is ready" lead="hos already runs on a brain, so there is nothing to create.">
        <button type="button" className="primary" onClick={onNext}>
          Continue
        </button>
      </Screen>
    );
  }
  const create = () =>
    run(async () => {
      await client.createBrain({
        from,
        path,
        ...(from === 'clone' ? { url } : {}),
        ...(from === 'starter' && remote.trim() ? { remote } : {}),
        ...(owner.name.trim() ? { name: owner.name.trim() } : {}),
        ...(owner.timezone.trim() ? { timezone: owner.timezone.trim() } : {}),
      });
      setPhase('restarting');
      const until = Date.now() + RESTART_WAIT_MS;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const state = await client.setup().catch(() => null);
        if (state && !state.needed) return onNext();
      }
      setPhase('form');
      throw new Error('hos did not come back on the new brain; check the terminal where it runs');
    });
  return (
    <Screen
      step={index}
      title="Your brain"
      lead="The brain is a git repo of your own: your rules, skills and profiles. Every chat runs inside it, and hos commits to it as you work."
    >
      <fieldset className="first-run-choice" disabled={busy}>
        <legend className="sr">Where your brain comes from</legend>
        <Choice checked={from === 'starter'} onPick={() => setFrom('starter')} title="Create your brain from the starter" detail="A copy of the hos starter brain, with five profiles and a few skills. Recommended." />
        <Choice checked={from === 'existing'} onPick={() => setFrom('existing')} title="Use a brain I already have" detail="A folder on this computer with a hos/ folder in it." />
        <Choice checked={from === 'clone'} onPick={() => setFrom('clone')} title="Clone my own brain" detail="Your brain’s repo, from a git URL." />
      </fieldset>
      {from === 'clone' && (
        <label>
          <span className="field-label">Your brain’s repo</span>
          <input value={url} spellCheck={false} autoCapitalize="none" placeholder="git@github.com:you/my-brain.git" onChange={(e) => setUrl(e.target.value)} />
        </label>
      )}
      <label>
        <span className="field-label">{from === 'existing' ? 'Brain folder' : 'Put it in'}</span>
        <input value={path} spellCheck={false} autoCapitalize="none" onChange={(e) => setPath(e.target.value)} />
      </label>
      {from === 'starter' && (
        <>
          <label>
            <span className="field-label">Your private repo (optional)</span>
            <input value={remote} spellCheck={false} autoCapitalize="none" placeholder="git@github.com:you/my-brain.git" onChange={(e) => setRemote(e.target.value)} />
          </label>
          <p className="hint">hos pushes your brain here as its backup. Keep it private. You can add one later.</p>
        </>
      )}
      <button type="button" className="primary" disabled={busy || !path.trim() || (from === 'clone' && !url.trim())} onClick={create}>
        {phase === 'restarting' ? 'Starting hos on your brain…' : busy ? 'Creating your brain…' : from === 'existing' ? 'Use this brain' : 'Create my brain'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <details className="first-run-cli">
        <summary>Prefer the command line?</summary>
        <p className="hint">Run these, then open this page again:</p>
        <pre>{ready?.commands.join('\n')}</pre>
      </details>
    </Screen>
  );
}

function Choice({ checked, onPick, title, detail }: { checked: boolean; onPick(): void; title: string; detail: string }) {
  return (
    <label className={`first-run-option${checked ? ' on' : ''}`}>
      <input type="radio" name="first-run-choice" checked={checked} onChange={onPick} />
      <span>
        <strong>{title}</strong>
        <span className="hint">{detail}</span>
      </span>
    </label>
  );
}

function Claude({ onNext }: { onNext(): void }) {
  const [rows, setRows] = useState<StatusItem[]>();
  const { error, busy, run } = useAction();
  const check = () => run(async () => setRows((await client.doctorChecks()).filter((row) => /login/i.test(row.label))));
  useEffect(() => {
    void check();
  }, []);
  const signedIn = !!rows?.length && rows.every((row) => row.status === 'ok');
  return (
    <Screen step={2} title="Your coding agent" lead="hos runs Claude Code, signed in with your own Claude account. hos never sees your password or token, and usage counts against your Claude plan.">
      <ul className="first-run-checks" aria-label="Sign-in checks">
        {rows?.map((row) => (
          <li key={row.id} className={`status-${row.status}`}>
            <strong>{row.label}</strong> <span>{row.detail}</span>
            {row.fix && (
              <span className="hint">
                Fix: <code>{row.fix}</code>, then check again.
              </span>
            )}
          </li>
        ))}
        {!rows && <li className="hint">Checking…</li>}
      </ul>
      <button type="button" className="quiet" disabled={busy} onClick={() => void check()}>
        Check again
      </button>
      <p className="hint">
        Want another coding agent? Read <a href={HARNESS_GUIDE} target="_blank" rel="noreferrer">Add a harness</a>.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="primary" onClick={onNext}>
        {signedIn ? 'Continue' : 'Continue without signing in'}
      </button>
    </Screen>
  );
}

function ProjectsStep({ state, onNext }: { state: State; onNext(): void }) {
  const [page, setPage] = useState<SettingsPage>();
  useEffect(() => {
    void client.settings().then(setPage, () => {});
  }, []);
  const roots = page?.sections.find((s) => s.id === 'projects')?.settings.find((s) => s.key === 'Folders to search')?.value;
  return (
    <Screen step={3} title="Your projects" lead="The repos chats can work in. hos lists the git repos it finds in your code folders; add any other one by path.">
      {roots && (
        <p className="hint">
          Looking in <code>{roots}</code>. Change it with <code>repo_roots</code> in Settings → Projects.
        </p>
      )}
      <div className="first-run-projects">
        <Projects state={state} />
      </div>
      <button type="button" className="primary" onClick={onNext}>
        Continue
      </button>
    </Screen>
  );
}

function Phone({ onNext }: { onNext(): void }) {
  const [reach, setReach] = useState<'local' | 'tailscale' | 'cloudflare'>('local');
  return (
    <Screen step={4} title="Keep it running, reach it from your phone" lead="Both are optional, and both can wait. You can change them later in Settings.">
      <h3>Start hos when you log in</h3>
      <p className="hint">
        hos runs in the background and restarts if it stops. In a terminal, run <code>hos keeper install</code>.
      </p>
      <h3>Reach it from your phone</h3>
      <fieldset className="first-run-choice">
        <legend className="sr">How you reach this computer</legend>
        <Choice checked={reach === 'local'} onPick={() => setReach('local')} title="Not now" detail="hos stays on this computer only. Nothing is open to the network." />
        <Choice checked={reach === 'tailscale'} onPick={() => setReach('tailscale')} title="Tailscale" detail="Your own private network. hos serves on this computer’s tailnet name." />
        <Choice checked={reach === 'cloudflare'} onPick={() => setReach('cloudflare')} title="Cloudflare Tunnel" detail="A hostname on a domain you own, behind your Cloudflare Access login." />
      </fieldset>
      {reach !== 'local' && (
        <p className="hint">
          Set <code>transport: {reach}</code> in Settings → Phone &amp; remote access, then restart hos. Each phone signs in with its own passkey. Pair only devices you own.
        </p>
      )}
      <button type="button" className="primary" onClick={onNext}>
        Continue
      </button>
    </Screen>
  );
}

function Done({ onDone }: { onDone(): void }) {
  const open = (prompt?: string) => {
    onDone();
    location.hash = prompt ? `#/new?prompt=${encodeURIComponent(prompt)}` : '#/';
  };
  return (
    <Screen step={STEPS.length} title="You’re set up" lead="Start your first chat. It uses the generic profile, which can use every hos feature.">
      <ul className="first-run-prompts" aria-label="Starter prompts">
        {STARTER_PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button type="button" className="quiet" onClick={() => open(prompt)}>
              {prompt}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="primary" onClick={() => open()}>
        Open hos
      </button>
    </Screen>
  );
}
