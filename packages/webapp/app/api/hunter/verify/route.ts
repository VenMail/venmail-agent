import { NextResponse } from 'next/server';
import {
  buildHunterProviderError,
  mapHunterResponseToProviderResult,
  validateLookup
} from '@venmail/shared';

const HUNTER_API_URL = 'https://api.hunter.io/v2/email-verifier';

interface RequestPayload {
  email: string;
  domain?: string;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = (await request.json()) as RequestPayload;
    const { valid, errors } = validateLookup({ email: payload.email, domain: payload.domain });

    if (!valid || !payload.email) {
      return NextResponse.json(
        { success: false, error: errors[0] ?? 'Email is required for verification.' },
        { status: 400 }
      );
    }

    const apiKey = process.env.HUNTER_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: 'Hunter.io API key is not configured on the server.' },
        { status: 503 }
      );
    }

    const url = new URL(HUNTER_API_URL);
    url.searchParams.set('email', payload.email);
    url.searchParams.set('api_key', apiKey);

    const response = await fetch(url, {
      method: 'GET',
      signal: request.signal
    });

    if (!response.ok) {
      const detail = await safeReadText(response);
      const providerError = buildHunterProviderError(
        'hunter-io',
        `Hunter.io request failed (${response.status})`,
        detail || undefined
      );

      return NextResponse.json(
        { success: false, error: providerError.error, providerResult: providerError },
        { status: response.status }
      );
    }

    const hunterPayload = await response.json();
    const mapped = mapHunterResponseToProviderResult(hunterPayload);

    if (!mapped) {
      return NextResponse.json(
        { success: false, error: 'Hunter.io returned no verification data.' },
        { status: 502 }
      );
    }

    if (payload.domain && !mapped.companyInfo?.website) {
      mapped.companyInfo = {
        ...(mapped.companyInfo ?? {}),
        website: `https://${payload.domain}`
      };
    }

    return NextResponse.json({ success: true, provider: 'hunter-io', result: mapped });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch (error) {
    console.warn('Failed to read response text', error);
    return null;
  }
}
