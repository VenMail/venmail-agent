import { LookupProgressUpdate } from '@venmail/shared';
import { memo, useMemo } from 'react';

interface LookupProgressTimelineProps {
  updates: LookupProgressUpdate[];
  fallbackStage?: LookupProgressUpdate | null;
  emptyLabel?: string;
}

function LookupProgressTimelineComponent({
  updates,
  fallbackStage,
  emptyLabel = 'Awaiting progress updates…'
}: LookupProgressTimelineProps): JSX.Element {
  const entries = useMemo(() => {
    if (updates.length) {
      return updates;
    }
    return fallbackStage ? [fallbackStage] : [];
  }, [updates, fallbackStage]);

  if (!entries.length) {
    return <p className="lookup-progress__empty">{emptyLabel}</p>;
  }

  return (
    <ul className="lookup-progress__list">
      {entries.map((entry) => (
        <li key={`${entry.lookupKey}-${entry.timestamp}`} className="lookup-progress__item">
          <div className="lookup-progress__meta">
            <span className="lookup-progress__stage">{entry.stage}</span>
            {entry.taskId ? <span className="task-tag">{entry.taskId}</span> : null}
          </div>
          <div className="lookup-progress__details">
            <span className="lookup-progress__timestamp">{new Date(entry.timestamp).toLocaleTimeString()}</span>
            {entry.notes?.length ? (
              <p className="lookup-progress__notes">{entry.notes.join(' ')}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export const LookupProgressTimeline = memo(LookupProgressTimelineComponent);
