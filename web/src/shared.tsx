import type { ReactNode } from 'react';

export function ViewHeader({ title, back, children, subtitle }: { title: string; back?: boolean; children?: ReactNode; subtitle?: ReactNode }) {
  return (
    <header className="view-header">
      {back && (
        <a className="back" href="#/">
          ‹ Home
        </a>
      )}
      <div className="title">
        <h1>{title}</h1>
      </div>
      {subtitle && <p className="subtitle">{subtitle}</p>}
      {children && <div className="header-actions">{children}</div>}
    </header>
  );
}

export const DECISION_LABELS: Record<string, string> = {
  approve: 'Approved once',
  deny: 'Denied',
  cancelled: 'Cancelled',
};
