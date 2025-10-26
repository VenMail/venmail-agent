/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';

import { extractContactOutResult } from './extractor';

const MOCK_TIMESTAMP = '2025-01-01T00:00:00.000Z';

const SAMPLE_PROFILE_HTML = `
  <main>
    <section class="contact-card">
      <h1 data-testid="profile-name">Jane Doe</h1>
      <div data-testid="headline">Head of Engineering</div>
      <div data-testid="company">
        <a href="https://example.com">Example Inc</a>
      </div>
      <div data-testid="email">jane.doe@example.com</div>
      <div data-testid="phone">+1 555 0100</div>
      <div data-testid="location">San Francisco, CA</div>
      <a href="https://www.linkedin.com/in/janedoe">LinkedIn</a>
    </section>
  </main>
`;

describe('extractContactOutResult', () => {
  beforeEach(() => {
    document.body.innerHTML = SAMPLE_PROFILE_HTML;
  });

  it('extracts ContactOut profile data with deterministic timestamp', () => {
    const result = extractContactOutResult({ timestamp: () => MOCK_TIMESTAMP });

    expect(result.provider).toBe('contactout');
    expect(result.signals.emailVerified).toBe(true);
    expect(result.companyInfo).toEqual({ name: 'Example Inc', website: 'https://example.com' });
    expect(result.additionalData).toMatchObject({
      jobTitle: 'Head of Engineering',
      phoneNumbers: ['+1 555 0100'],
      locations: ['San Francisco, CA'],
      verifiedEmail: true
    });
    expect(result.socialProfiles?.linkedin).toBe('https://www.linkedin.com/in/janedoe');
    expect(result.notes?.[0]).toBe(`Captured ContactOut data at ${MOCK_TIMESTAMP}`);
    expect(result.fetchedAt).toBe(MOCK_TIMESTAMP);
  });

  it('notes mismatch between requested target and captured name', () => {
    const result = extractContactOutResult({
      targetLabel: 'John Smith',
      timestamp: () => MOCK_TIMESTAMP
    });

    expect(result.notes?.some((note) => note.includes('differs from captured name'))).toBe(true);
  });

  it('falls back to scanning document text when explicit email element is missing', () => {
    document.body.innerHTML = `
      <main>
        <section class="contact-card">
          <h1 data-testid="profile-name">Jane Doe</h1>
          <div data-testid="headline">VP, Product</div>
        </section>
      </main>
      <footer>Reach me at jane.doe@example.com</footer>
    `;

    const result = extractContactOutResult({ timestamp: () => MOCK_TIMESTAMP });

    expect(result.additionalData).toBeDefined();
    expect(result.additionalData?.verifiedEmail).toBe(true);
    expect(result.additionalData?.phoneNumbers).toBeUndefined();
    expect(result.additionalData?.locations).toBeUndefined();
    expect(result.companyInfo).toEqual({ name: '', website: '' });
  });

  it('supports scoped extraction when a sub-tree is provided', () => {
    document.body.innerHTML = `
      <main>
        <section class="contact-card" id="scope">
          <h1 data-testid="profile-name">Alex Smith</h1>
          <div data-testid="company"><a href="https://acme.test">Acme</a></div>
          <a href="mailto:alex@acme.test">alex@acme.test</a>
        </section>
        <section class="contact-card">
          <h1 data-testid="profile-name">Other Person</h1>
        </section>
      </main>
    `;

    const scope = document.getElementById('scope');
    const result = extractContactOutResult({ root: scope as Element, timestamp: () => MOCK_TIMESTAMP });

    expect(result.companyInfo).toEqual({ name: 'Acme', website: 'https://acme.test' });
    expect(result.additionalData).toBeDefined();
    expect(result.additionalData?.verifiedEmail).toBe(true);
  });

  it('throws when neither name nor email are detected', () => {
    document.body.innerHTML = '<main><p>No data</p></main>';

    expect(() => extractContactOutResult({ timestamp: () => MOCK_TIMESTAMP })).toThrow(
      /No contact details detected/
    );
  });
});
