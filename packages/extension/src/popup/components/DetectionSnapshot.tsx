import { DetectedContactSnapshot } from '@venmail/shared';
import { memo } from 'react';

export interface DetectionSnapshotProps {
  snapshot: DetectedContactSnapshot | null;
  onLookup: (value: string, type: 'email' | 'phone') => void;
}

function DetectionSnapshotComponent({ snapshot, onLookup }: DetectionSnapshotProps): JSX.Element {
  if (!snapshot || snapshot.contacts.length === 0) {
    return <p className="empty-state">No detected contacts yet.</p>;
  }

  return (
    <div className="detection-list">
      <p className="detection-meta">
        {snapshot.url ? (
          <>
            from{' '}
            <a href={snapshot.url} target="_blank" rel="noreferrer">
              {snapshot.title ?? snapshot.url}
            </a>
          </>
        ) : (
          'From this page'
        )}
      </p>
      <ul>
        {snapshot.contacts.map((contact) => (
          <li key={`${contact.type}:${contact.value}`}>
            <span className="contact-value">{contact.value}</span>
            <button type="button" onClick={() => onLookup(contact.value, contact.type)}>
              Lookup
            </button>
            {contact.context ? <span className="contact-context">{contact.context}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export const DetectionSnapshot = memo(DetectionSnapshotComponent);
