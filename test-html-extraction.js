#!/usr/bin/env node

/**
 * Real-world HTML extraction test for Andrew Chen
 * Tests the algorithm against realistic HTML patterns from actual websites
 */

// const { JSDOM } = require('jsdom'); // Not needed for this test

// Same extraction utilities as before
const EMAIL_REGEX = /\b[a-z0-9][a-z0-9._%+\-]{0,63}@[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)*\.[a-z]{2,}\b/gi;
const PHONE_REGEX = /(?:\+?\d{1,3}[-\.\s]?)?(?:\(?\d{1,4}\)?[-\.\s]?)?\d{1,4}[-\.\s]?\d{1,4}[-\.\s]?\d{1,9}\b/g;

// Mock HTML content from real-world websites
const mockHtmlPages = [
  {
    url: 'https://a16z.com/team/andrew-chen/',
    title: 'Andrew Chen - Partner - Andreessen Horowitz',
    html: `
    <!DOCTYPE html>
    <html>
    <head><title>Andrew Chen - Partner</title></head>
    <body>
        <div class="team-member">
            <h1>Andrew Chen</h1>
            <h2>Partner</h2>
            <div class="bio">
                Andrew Chen is a partner at Andreessen Horowitz where he focuses on consumer tech, 
                growth, and marketplace investing.
            </div>
            <div class="contact-info">
                <p>Email: <a href="mailto:andrew@a16z.com">andrew@a16z.com</a></p>
                <p>Phone: +1-415-555-0123</p>
                <div class="social-links">
                    <a href="https://twitter.com/andrewchen">@andrewchen</a>
                    <a href="https://linkedin.com/in/andrewchen">LinkedIn</a>
                </div>
            </div>
        </div>
    </body>
    </html>
    `
  },
  {
    url: 'https://andrewchen.co/contact',
    title: 'Andrew Chen - Contact',
    html: `
    <!DOCTYPE html>
    <html>
    <head><title>Contact Andrew Chen</title></head>
    <body>
        <section class="contact">
            <h1>Get in Touch</h1>
            <p>For consulting inquiries, please reach out:</p>
            <div class="contact-methods">
                <div class="email">
                    <strong>Email:</strong> 
                    <span class="obfuscated">andrew [at] andrewchen [dot] co</span>
                </div>
                <div class="phone">
                    <strong>Phone:</strong> (415) 555-0456
                </div>
            </div>
            <form class="contact-form">
                <input type="email" name="email" placeholder="your@email.com">
                <input type="tel" name="phone" placeholder="+1-555-000-0000">
            </form>
        </section>
    </body>
    </html>
    `
  },
  {
    url: 'https://medium.com/@andrewchen',
    title: 'Andrew Chen - Medium',
    html: `
    <!DOCTYPE html>
    <html>
    <head><title>Andrew Chen - Medium</title></head>
    <body>
        <article>
            <h1>Andrew Chen</h1>
            <div class="author-bio">
                <p>Partner @a16z. Writing about growth, startups, and marketplace businesses.</p>
                <p>Contact: <a href="mailto:andrew@medium.com">andrew@medium.com</a></p>
                <p>Business inquiries: 415-555-0567</p>
            </div>
            <div class="article-content">
                <p>You can reach me at andrew.chen@example.com for collaborations.</p>
            </div>
        </article>
    </body>
    </html>
    `
  },
  {
    url: 'https://speaker.com/andrew-chen',
    title: 'Andrew Chen - Speaker Profile',
    html: `
    <!DOCTYPE html>
    <html>
    <head><title>Book Andrew Chen</title></head>
    <body>
        <div class="speaker-profile">
            <h1>Andrew Chen</h1>
            <div class="bio">
                <p>Growth expert and venture capitalist</p>
            </div>
            <div class="booking-info">
                <h2>Booking Information</h2>
                <p>For speaking engagements:</p>
                <ul>
                    <li>Agent: <a href="mailto:speaker@andrewchen.com">speaker@andrewchen.com</a></li>
                    <li>Direct line: +1 (415) 555-0890</li>
                    <li>Emergency: +1-415-555-0912</li>
                </ul>
            </div>
        </div>
    </body>
    </html>
    `
  },
  {
    url: 'https://crunchbase.com/person/andrew-chen',
    title: 'Andrew Chen - Crunchbase',
    html: `
    <!DOCTYPE html>
    <html>
    <head><title>Andrew Chen - Crunchbase</title></head>
    <body>
        <div class="profile-header">
            <h1>Andrew Chen</h1>
            <div class="title">Partner at Andreessen Horowitz</div>
        </div>
        <div class="contact-section">
            <h2>Contact Information</h2>
            <div class="contact-item">
                <span class="label">Work Email:</span>
                <span class="value">andrew.chen@a16z.com</span>
            </div>
            <div class="contact-item">
                <span class="label">Phone:</span>
                <span class="value">+1-415-555-0234</span>
            </div>
            <div class="contact-item">
                <span class="label">LinkedIn:</span>
                <a href="https://linkedin.com/in/andrewchen">View Profile</a>
            </div>
        </div>
        <script type="application/ld+json">
        {
            "email": "andrew.chen@a16z.com",
            "telephone": "+1-415-555-0234"
        }
        </script>
    </body>
    </html>
    `
  }
];

// Extraction utilities (same as previous test)
function isValidEmail(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  
  const [local, domain] = parts;
  
  if (!local || local.length > 64 || !domain || domain.length > 255) return false;
  
  const localLower = local.toLowerCase();
  const blacklist = ['noreply', 'no-reply', 'example', 'test', 'demo', 'user@', 'email@'];
  if (blacklist.some(b => localLower.startsWith(b))) return false;
  
  if (email.includes('..') || local.startsWith('.') || local.endsWith('.')) return false;
  
  if (!/^[a-z0-9._%+\-]+$/i.test(local)) return false;
  
  return true;
}

function isGenericEmail(email) {
  const localPart = email.split('@')[0]?.toLowerCase() || '';
  const generic = ['info', 'contact', 'support', 'help', 'sales', 'admin', 'service', 'hello', 'hi', 'team'];
  return generic.some(prefix => localPart === prefix || localPart.startsWith(`${prefix}.`));
}

function isValidPhoneStructure(phone) {
  const digitsOnly = phone.replace(/\D/g, '');
  
  if (digitsOnly.length < 7 || digitsOnly.length > 15) return false;
  
  if (/^(0+|1{7,}|(\d)\1{6,})$/.test(digitsOnly)) return false;
  
  return true;
}

function sanitizePhone(raw) {
  const cleaned = raw.replace(/[^0-9+]/g, '');
  const digitCount = cleaned.replace(/\+/g, '').length;
  
  if (digitCount < 7 || digitCount > 15) return null;
  
  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  
  if (digitCount === 10) {
    return `+1${cleaned}`;
  }
  
  if (digitCount >= 11) {
    return `+${cleaned}`;
  }
  
  return `+${cleaned}`;
}

function extractVisibleText(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeObfuscatedEmail(text) {
  return text
    .replace(/\[at\]/gi, '@')
    .replace(/\(at\)/gi, '@')
    .replace(/(\b[a-z0-9._%+\-]{1,64})\s+at\s+([a-z0-9][a-z0-9.\-]{0,61}\.[a-z]{2,})\b/gi, '$1@$2')
    .replace(/\[dot\]/gi, '.')
    .replace(/\(dot\)/gi, '.');
}

function extractEmailsFromHtml(html) {
  const searchText = extractVisibleText(html);
  const decodedText = decodeObfuscatedEmail(searchText);

  // Extract from mailto: links in raw HTML
  const mailtoMatches = Array.from(html.matchAll(/mailto:([a-z0-9][a-z0-9._%+\-]{0,63}@[a-z0-9][a-z0-9.\-]*\.[a-z]{2,})/gi)).map(m => (m[1] || '').toLowerCase());
  
  const regexMatches = Array.from(decodedText.matchAll(EMAIL_REGEX)).map((match) => match[0].toLowerCase());
  const allMatches = [...regexMatches, ...mailtoMatches];
  
  const validated = allMatches.filter(email => isValidEmail(email));
  return Array.from(new Set(validated));
}

function extractPhonesFromHtml(html) {
  const searchText = extractVisibleText(html);
  const matches = Array.from(searchText.matchAll(PHONE_REGEX)).map((match) => match[0].trim());
  
  const validated = [];
  for (const phone of matches) {
    if (!isValidPhoneStructure(phone)) continue;
    
    const sanitized = sanitizePhone(phone);
    if (!sanitized) continue;
    
    validated.push(sanitized);
  }
  
  return Array.from(new Set(validated));
}

function scoreEmail(email, context = {}) {
  let score = 50;
  const reasons = [];
  
  if (context.name) {
    const nameParts = context.name.toLowerCase().split(/\s+/);
    const emailLocal = email.split('@')[0]?.toLowerCase() || '';
    
    if (nameParts.some(part => part.length > 2 && emailLocal.includes(part))) {
      score += 20;
      reasons.push('name-match');
    }
  }
  
  if (isGenericEmail(email)) {
    score -= 15;
    reasons.push('generic');
  }
  
  const tld = email.split('.').pop()?.toLowerCase();
  if (tld === 'edu' || tld === 'gov') {
    score += 10;
    reasons.push('trusted-tld');
  }
  
  return {
    value: email,
    score: Math.max(0, Math.min(100, score)),
    reason: reasons.length ? reasons.join(',') : undefined
  };
}

function scorePhone(phone, context = {}) {
  let score = 50;
  const reasons = [];
  
  const digitsOnly = phone.replace(/\D/g, '');
  
  if (digitsOnly.length >= 10 && digitsOnly.length <= 11) {
    score += 10;
    reasons.push('standard-length');
  }
  
  if (phone.startsWith('+')) {
    score += 5;
    reasons.push('international-format');
  }
  
  if (digitsOnly.length === 10 || (digitsOnly.length === 11 && digitsOnly.startsWith('1'))) {
    score += 10;
    reasons.push('us-format');
  }
  
  return {
    value: phone,
    score: Math.max(0, Math.min(100, score)),
    reason: reasons.length ? reasons.join(',') : undefined
  };
}

function runHtmlExtractionTest() {
  console.log('='.repeat(80));
  console.log('REAL-WORLD HTML EXTRACTION TEST FOR "Andrew Chen"');
  console.log('='.repeat(80));
  
  const allResults = [];
  const context = { name: 'Andrew Chen' };
  
  for (const page of mockHtmlPages) {
    console.log(`\n📄 ${page.title}`);
    console.log(`🔗 ${page.url}`);
    console.log('-'.repeat(60));
    
    // Extract from HTML
    const emails = extractEmailsFromHtml(page.html);
    const phones = extractPhonesFromHtml(page.html);
    
    console.log(`📧 Emails found: ${emails.length}`);
    if (emails.length > 0) {
      const scoredEmails = emails.map(email => scoreEmail(email, context));
      scoredEmails.forEach(scored => {
        console.log(`   - ${scored.value} (score: ${scored.score}, reason: ${scored.reason || 'none'})`);
      });
      allResults.push(...scoredEmails.map(e => ({ ...e, source: 'html', url: page.url })));
    }
    
    console.log(`📞 Phones found: ${phones.length}`);
    if (phones.length > 0) {
      const scoredPhones = phones.map(phone => scorePhone(phone, context));
      scoredPhones.forEach(scored => {
        console.log(`   - ${scored.value} (score: ${scored.score}, reason: ${scored.reason || 'none'})`);
      });
      allResults.push(...scoredPhones.map(p => ({ ...p, source: 'html', url: page.url })));
    }
    
    if (emails.length === 0 && phones.length === 0) {
      console.log('❌ No contact info found in HTML');
    }
    
    // Show raw text extraction for comparison
    const visibleText = extractVisibleText(page.html);
    console.log(`📝 Visible text preview: ${visibleText.substring(0, 200)}...`);
  }
  
  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('HTML EXTRACTION SUMMARY');
  console.log('='.repeat(80));
  
  const emailResults = allResults.filter(r => r.value.includes('@'));
  const phoneResults = allResults.filter(r => !r.value.includes('@'));
  
  console.log(`\n📧 TOTAL EMAILS EXTRACTED: ${emailResults.length}`);
  if (emailResults.length > 0) {
    const uniqueEmails = Array.from(new Map(emailResults.map(e => [e.value.toLowerCase(), e])).values());
    uniqueEmails.sort((a, b) => b.score - a.score);
    
    console.log('\nTop emails by score:');
    uniqueEmails.slice(0, 10).forEach((email, i) => {
      console.log(`${i + 1}. ${email.value} (score: ${email.score})`);
      console.log(`   Found on: ${email.url}`);
      console.log(`   Reason: ${email.reason || 'none'}`);
    });
  }
  
  console.log(`\n📞 TOTAL PHONES EXTRACTED: ${phoneResults.length}`);
  if (phoneResults.length > 0) {
    const uniquePhones = Array.from(new Map(phoneResults.map(p => [p.value, p])).values());
    uniquePhones.sort((a, b) => b.score - a.score);
    
    console.log('\nTop phones by score:');
    uniquePhones.slice(0, 10).forEach((phone, i) => {
      console.log(`${i + 1}. ${phone.value} (score: ${phone.score})`);
      console.log(`   Found on: ${phone.url}`);
      console.log(`   Reason: ${phone.reason || 'none'}`);
    });
  }
  
  // Test specific extraction challenges
  console.log('\n' + '='.repeat(80));
  console.log('EXTRACTION CHALLENGES TEST');
  console.log('='.repeat(80));
  
  console.log('\n🔍 Testing obfuscated email patterns:');
  const obfuscatedTest = 'andrew [at] andrewchen [dot] co';
  const decoded = decodeObfuscatedEmail(obfuscatedTest);
  console.log(`   Input: "${obfuscatedTest}"`);
  console.log(`   Decoded: "${decoded}"`);
  console.log(`   Extracted emails: ${extractEmailsFromHtml(`<p>${decoded}</p>`).join(', ')}`);
  
  console.log('\n🔍 Testing mailto: link extraction:');
  const mailtoTest = '<a href="mailto:andrew@a16z.com">Email me</a>';
  console.log(`   HTML: ${mailtoTest}`);
  console.log(`   Extracted emails: ${extractEmailsFromHtml(mailtoTest).join(', ')}`);
  
  console.log('\n🔍 Testing phone format variations:');
  const phoneFormats = [
    '+1-415-555-0123',
    '(415) 555-0456',
    '415-555-0789',
    '+1 (415) 555-0890',
    '415.555.0912'
  ];
  
  phoneFormats.forEach(format => {
    const extracted = extractPhonesFromHtml(`<p>${format}</p>`);
    console.log(`   "${format}" -> ${extracted.join(', ')}`);
  });
  
  const totalContactInfo = emailResults.length + phoneResults.length;
  const success = totalContactInfo > 0;
  
  console.log('\n' + '='.repeat(80));
  console.log('HTML EXTRACTION TEST COMPLETE');
  console.log('='.repeat(80));
  console.log(`\n📊 Final Results:`);
  console.log(`   Total contact info extracted from HTML: ${totalContactInfo}`);
  console.log(`   Success: ${success ? '✅ YES' : '❌ NO'}`);
  
  return {
    totalEmails: emailResults.length,
    totalPhones: phoneResults.length,
    success
  };
}

// Run the test
if (require.main === module) {
  const results = runHtmlExtractionTest();
  process.exit(results.success ? 0 : 1);
}

module.exports = { runHtmlExtractionTest };
