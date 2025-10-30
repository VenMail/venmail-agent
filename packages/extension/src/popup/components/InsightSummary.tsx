import { ReputationResponse } from '@venmail/shared';
import { memo } from 'react';

interface InsightSummaryProps {
  response: ReputationResponse;
}

function InsightSummaryComponent({ response }: InsightSummaryProps): JSX.Element {
  const { additionalData, reputation, companyInfo, socialProfiles } = response;
  const phoneNumbers = additionalData.phoneNumbers ?? [];
  const locations = additionalData.locations ?? [];
  const socialEntries = Object.entries(socialProfiles).filter(([, url]) => Boolean(url)) as [string, string][];
  const reputationSources = reputation.sources.slice(0, 4);
  const actionableTakeaways: { label: string; tone: 'positive' | 'warning' | 'info'; action?: () => void }[] = [];
  const badges: { label: string; tone: 'positive' | 'info' | 'neutral' }[] = [];
  const confidenceScores = additionalData.confidenceScores ?? {};

  if (reputation.status === 'verified' || reputation.score >= 80) {
    actionableTakeaways.push({ label: 'Profile looks strong — share contact with confidence.', tone: 'positive' });
    badges.push({ label: 'Verified reputation', tone: 'positive' });
  }

  if (additionalData.trustedSources?.length) {
    actionableTakeaways.push({
      label: `Trusted sources found on ${additionalData.trustedSources.length} site${additionalData.trustedSources.length > 1 ? 's' : ''}.`,
      tone: 'positive'
    });
    badges.push({ label: 'Trusted sources confirmed', tone: 'positive' });
  }

  if (additionalData.mapSummary?.rating && additionalData.mapSummary.rating >= 4.2) {
    actionableTakeaways.push({
      label: `Excellent Maps presence (${additionalData.mapSummary.rating.toFixed(1)}/5).`,
      tone: 'positive'
    });
    badges.push({ label: `${additionalData.mapSummary.rating.toFixed(1)}★ on Maps`, tone: 'positive' });
  }

  if (additionalData.negativeMentions?.length) {
    actionableTakeaways.push({
      label: `Investigate ${additionalData.negativeMentions.length} negative mention${additionalData.negativeMentions.length > 1 ? 's' : ''}.`,
      tone: 'warning'
    });
  }

  if ((confidenceScores.social ?? 0) >= 60) {
    actionableTakeaways.push({
      label: 'Follow up on LinkedIn — strong social presence detected.',
      tone: 'positive',
      action: additionalData.socialLinks?.linkedin ? () => window.open(additionalData.socialLinks?.linkedin, '_blank') : undefined
    });
    badges.push({ label: 'Strong social presence', tone: 'positive' });
  }

  if ((confidenceScores.contact ?? 0) >= 60) {
    actionableTakeaways.push({
      label: 'Call or email using verified contact channel.',
      tone: 'positive'
    });
    badges.push({ label: 'Contact channel verified', tone: 'positive' });
  }

  if (!badges.length) {
    badges.push({ label: 'Signals still building', tone: 'neutral' });
  }

  if (!actionableTakeaways.length) {
    actionableTakeaways.push({
      label: 'Gather more signals to enrich this profile.',
      tone: 'info'
    });
  }

  const quickStats = [
    {
      label: 'Reputation score',
      value: reputation.score.toString(),
      detail: reputation.status
    },
    {
      label: 'Email status',
      value: additionalData.verifiedEmail ? 'Verified' : 'Unverified',
      detail: additionalData.verifiedEmail ? 'Delivery safe' : 'Needs validation'
    },
    {
      label: 'Phone signals',
      value: phoneNumbers.length > 0 ? phoneNumbers[0] : 'Not surfaced',
      detail: phoneNumbers.length > 1 ? `+${phoneNumbers.length - 1} more` : undefined
    },
    {
      label: 'Geo presence',
      value: locations.length > 0 ? locations[0] : 'Not detected',
      detail: locations.length > 1 ? `+${locations.length - 1} regions` : undefined
    }
  ];

  return (
    <section className="insight-card insight-summary">
      <div className="insight-card__header">
        <h2>Insight summary</h2>
        <span className="tag">
          Updated {response.generatedAt ? new Date(response.generatedAt).toLocaleTimeString() : 'moments ago'}
        </span>
      </div>

      <ul className="insight-actions">
        {actionableTakeaways.map((item, index) => (
          <li key={`${item.label}-${index}`} className={`insight-actions__item insight-actions__item--${item.tone}`}>
            <button
              type="button"
              onClick={item.action}
              disabled={!item.action}
              className={item.action ? 'insight-actions__cta' : undefined}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>

      <div className="insight-badges">
        {badges.map((badge, index) => (
          <span key={`${badge.label}-${index}`} className={`insight-badge insight-badge--${badge.tone}`}>
            {badge.label}
          </span>
        ))}
      </div>

      <div className="insight-highlights">
        {quickStats.map((item) => (
          <div key={item.label} className="highlight-card">
            <span className="highlight-label">{item.label}</span>
            <span className="highlight-value">{item.value}</span>
            {item.detail && <span className="highlight-detail">{item.detail}</span>}
          </div>
        ))}
      </div>

      <div className="insight-body">
        <div className="insight-section">
          <h3>Company profile</h3>
          <dl className="insight-list">
            <div>
              <dt>Name</dt>
              <dd>{companyInfo.name || 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Website</dt>
              <dd>
                {companyInfo.website ? (
                  <a href={companyInfo.website} target="_blank" rel="noreferrer">
                    {companyInfo.website}
                  </a>
                ) : (
                  'Unavailable'
                )}
              </dd>
            </div>
            {companyInfo.industry && (
              <div>
                <dt>Industry</dt>
                <dd>{companyInfo.industry}</dd>
              </div>
            )}
            {companyInfo.size && (
              <div>
                <dt>Team size</dt>
                <dd>{companyInfo.size}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="insight-section">
          <h3>Digital presence</h3>
          {socialEntries.length > 0 ? (
            <ul className="insight-links">
              {socialEntries.map(([platform, url]) => (
                <li key={platform}>
                  <a href={url} target="_blank" rel="noreferrer">
                    {platform}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="insight-placeholder">No public profiles detected yet.</p>
          )}
        </div>

        <div className="insight-section">
          <h3>Signals referenced</h3>
          {reputationSources.length > 0 ? (
            <ul className="insight-pills">
              {reputationSources.map((source) => (
                <li key={source}>{source}</li>
              ))}
            </ul>
          ) : (
            <p className="insight-placeholder">Signals will appear here once gathered.</p>
          )}
        </div>
      </div>
    </section>
  );
}

export const InsightSummary = memo(InsightSummaryComponent);
