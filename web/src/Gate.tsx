import { useEffect, useState, type ReactNode } from 'react';
import { HosApiError } from '../../src/api/client.js';
import type { DoctorReport } from '../../src/api/types.js';
import { SESSION_KEY, client, useAction } from './lib.js';
import { Stepper } from './setup/FirstRun.js';
import { Wordmark } from './Sidebar.js';
import './styles/nav.css';

type Access =
  | { kind: 'checking' }
  | { kind: 'doctor'; report: DoctorReport }
  | { kind: 'elsewhere'; origin: string }
  | { kind: 'register'; setup: boolean }
  | { kind: 'sign-in' }
  | { kind: 'ready' };

async function checkAccess(): Promise<Access> {
  try {
    const session = await client.session();
    if (session.origin !== location.origin) return { kind: 'elsewhere', origin: session.origin };
    if (session.signedIn) return { kind: 'ready' };
    if (session.registered) return { kind: 'sign-in' };
    const setup = await client.setup().then((state) => state.needed, () => false);
    return { kind: 'register', setup };
  } catch (error) {
    if (error instanceof HosApiError && (error.status === 401 || error.status === 503)) {
      return { kind: 'doctor', report: await client.doctor() };
    }
    throw error;
  }
}

export function Gate({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<Access>({ kind: 'checking' });
  const [code, setCode] = useState('');
  const { error, busy, run } = useAction();
  useEffect(() => {
    void run(async () => setAccess(await checkAccess()));
  }, []);
  const passkey = (action: () => Promise<void>) =>
    run(async () => {
      await action();
      localStorage.setItem(SESSION_KEY, client.sessionToken!);
      setAccess(await checkAccess());
    });

  if (access.kind === 'ready') return children;
  return (
    <main className={`gate gate-${access.kind}`} aria-label="Sign in">
      <div className="gate-card">
        <h1>
          <Wordmark />
        </h1>
        {access.kind === 'checking' && !error && <p className="meta">Checking access…</p>}
        {access.kind === 'doctor' && <Doctor report={access.report} />}
        {access.kind === 'elsewhere' && (
          <p>
            Passkeys are tied to one address. Open hos at <a href={access.origin}>{access.origin}</a>.
          </p>
        )}
        {access.kind === 'register' && (
          <>
            {access.setup && (
              <div className="gate-setup">
                <Stepper step={0} />
                <h2>Set up hos</h2>
              </div>
            )}
            <p className="lead">First visit: create the passkey that guards hos. You use it only to sign in.</p>
            <label>
              <span className="field-label">Setup code</span>
              <input
                value={code}
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="enrolment-hint"
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <p className="hint" id="enrolment-hint">
              The one-time code hos printed in the terminal when it started. It is also in enrolment-code in its data folder.
            </p>
            <button className="primary" disabled={busy} onClick={() => passkey(() => client.registerPasskey(code))}>
              Create your hos passkey
            </button>
          </>
        )}
        {access.kind === 'sign-in' && (
          <>
            <p className="lead">Use the passkey saved for this address.</p>
            <button className="primary" disabled={busy} onClick={() => passkey(() => client.signIn())}>
              Sign in with passkey
            </button>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {plainError(error)}
          </p>
        )}
      </div>
    </main>
  );
}

function plainError(message: string): string {
  if (/not allowed|timed out|NotAllowedError|AbortError/i.test(message)) return 'The passkey prompt was closed or timed out. Try again.';
  if (/failed to fetch|networkerror|load failed/i.test(message)) return 'Can’t reach hos. Check that the daemon is running and try again.';
  return message;
}

function Doctor({ report }: { report: DoctorReport }) {
  return (
    <section className="doctor" aria-label="Doctor">
      <p className={report.ok ? 'ok' : 'warning'}>{report.message}</p>
      {report.fix.length > 0 && (
        <ol>
          {report.fix.map((fix) => (
            <li key={fix}>
              <code>{fix}</code>
            </li>
          ))}
        </ol>
      )}
      {report.passkeys?.length === 0 && <p>No origin has a hos passkey yet.</p>}
      {!!report.passkeys?.length && (
        <>
          <p>Passkeys are per origin. These have one:</p>
          <ul aria-label="Origins with a passkey">
            {report.passkeys.map((origin) => (
              <li key={origin}>{origin}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
