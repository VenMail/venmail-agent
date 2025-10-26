import type { ContactLookup } from './types';

export function validateLookup(input: ContactLookup): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!input.email && !input.name && !input.domain) {
    errors.push('Provide at least an email, name, or domain.');
  }

  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    errors.push('Email format appears invalid.');
  }

  if (input.domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(input.domain)) {
    errors.push('Domain format appears invalid.');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
