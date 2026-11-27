import { useEffect, useState } from 'react';
import { client } from './lib.js';

export function CodePr() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(location.hash.split('?')[1]);
    client.openPrLink(params.get('url') ?? '', params.get('topic') ?? '').then(
      ({ url }) => location.replace(url),
      (failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)),
    );
  }, []);
  return (
    <main className="gate" aria-label="Opening the pull request">
      <div className="gate-card">
        {error ? (
          <>
            <p className="error" role="alert">
              Could not open the pull request in Code view: {error}
            </p>
            <a href="/">Go to hos</a>
          </>
        ) : (
          <p className="meta">Opening the pull request in Code view…</p>
        )}
      </div>
    </main>
  );
}
