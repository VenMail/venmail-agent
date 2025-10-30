import { FormEvent } from 'react';
import type { ExtensionResponseMessage, LookupProgressUpdate } from '@venmail/shared';

export type LookupFormShape = {
  name: string;
  email: string;
  domain: string;
  company: string;
};

export type LookupFormErrors = Partial<Record<keyof LookupFormShape, string>>;

type ContextLookupState = NonNullable<ExtensionResponseMessage['contextLookup']>;

type ContactChannelType = 'email' | 'phone';

export interface SearchViewProps {
  lookupForm: LookupFormShape;
  lookupErrors: LookupFormErrors;
  isFetching: boolean;
  onFieldChange: (field: keyof LookupFormShape, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRefreshSelection: () => void;
  contextLookup: ContextLookupState | null;
  activeProgress: LookupProgressUpdate[];
  activeLookupKey: string | null;
}

export function SearchView({
  lookupForm,
  lookupErrors,
  isFetching,
  onFieldChange,
  onSubmit,
  onRefreshSelection,
  contextLookup,
  activeProgress,
  activeLookupKey
}: SearchViewProps): JSX.Element {
  const stages: LookupProgressUpdate[] = isFetching
    ? activeProgress.length
      ? activeProgress
      : activeLookupKey
      ? [
          {
            type: 'venmail-lookup-progress',
            stage: 'Preparing lookup…',
            timestamp: new Date().toISOString(),
            lookupKey: activeLookupKey
          }
        ]
      : []
    : [];

  return (
    <div className="tab-scroll">
      <section className="lookup-card">
        <header className="lookup-card__header">
          <div>
            <h2>Smart lookup</h2>
            <p>Context-aware fields pull from page selection automatically.</p>
          </div>
          <button type="button" className="ghost-button" onClick={onRefreshSelection}>
            Refresh selection
          </button>
        </header>

        <div className="lookup-card__body">
          <aside className="callout info">
            <strong>Tip:</strong> Highlight a name or email on the page and relaunch the popup to prefill the form instantly.
          </aside>

          <form className="lookup-form" onSubmit={onSubmit}>
            <div className="lookup-grid lookup-grid--two">
              <div className="field">
                <label className="field__label">Name</label>
                <input
                  type="text"
                  autoComplete="name"
                  placeholder="e.g. Jane Doe"
                  value={lookupForm.name}
                  onChange={(event) => onFieldChange('name', event.currentTarget.value)}
                />
                {lookupErrors.name && <span className="field__error">{lookupErrors.name}</span>}
              </div>

              <div className="field">
                <label className="field__label">Email</label>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="jane@example.com"
                  value={lookupForm.email}
                  onChange={(event) => onFieldChange('email', event.currentTarget.value)}
                />
                {lookupErrors.email && <span className="field__error">{lookupErrors.email}</span>}
              </div>

              <div className="field">
                <label className="field__label">Domain</label>
                <input
                  type="text"
                  inputMode="url"
                  placeholder="example.com"
                  value={lookupForm.domain}
                  onChange={(event) => onFieldChange('domain', event.currentTarget.value)}
                />
                {lookupErrors.domain && <span className="field__error">{lookupErrors.domain}</span>}
              </div>

              <div className="field">
                <label className="field__label">Company</label>
                <input
                  type="text"
                  placeholder="e.g. Example Inc."
                  value={lookupForm.company}
                  onChange={(event) => onFieldChange('company', event.currentTarget.value)}
                />
              </div>
            </div>

            <footer className="lookup-actions">
              <button type="submit" disabled={isFetching}>
                {isFetching ? 'Gathering insights…' : 'Reveal profile insights'}
              </button>

              <div className="lookup-status">
                {contextLookup?.updatedAt ? (
                  <div className="recent-lookup">
                    <span className="recent-lookup__label">Last request</span>
                    <div className="recent-lookup__meta">
                      <span>{new Date(contextLookup.updatedAt).toLocaleTimeString()}</span>
                      {contextLookup.error ? (
                        <span className="recent-lookup__error">{contextLookup.error}</span>
                      ) : (
                        <span>Ready</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="lookup-hint">Run a search to populate insights below.</p>
                )}
              </div>
            </footer>
          </form>
        </div>
      </section>

      <section className="insights-card insights-card--hint">
        <h2>What happens next</h2>
        <p>
          Submit the form and Venmail will collect SERP, Maps, profile, and contact signals automatically. Jump to
          <strong> Results</strong> to watch the progress.
        </p>
      </section>

      {stages.length ? (
        <section className="insights-card lookup-progress">
          <h2>Gathering signals…</h2>
          <ul>
            {stages.map((entry) => (
              <li key={`${entry.lookupKey}-${entry.timestamp}`}>
                <strong>{entry.stage}</strong>
                {entry.taskId ? <span className="task-tag">{entry.taskId}</span> : null}
                {entry.notes?.length ? <p>{entry.notes.join(' ')}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
