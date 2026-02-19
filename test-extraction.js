#!/usr/bin/env node

/**
 * Manual test script for SERP email/phone extraction
 * Tests the algorithm used in serpScan.ts for "Andrew Chen" searches
 */

// Import the extraction utilities (adapted for standalone test)
const EMAIL_REGEX = /\b[a-z0-9][a-z0-9._%+\-]{0,63}@[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)*\.[a-z]{2,}\b/gi;
const PHONE_REGEX = /(?:\+?\d{1,3}[-\.\s]?)?(?:\(?\d{1,4}\)?[-\.\s]?)?\d{1,4}[-\.\s]?\d{1,4}[-\.\s]?\d{1,9}\b/g;

const EMAIL_BLACKLIST_PREFIXES = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'bounce', 'mailer-daemon', 'postmaster',
  'example', 'test', 'sample', 'demo',
  'webmaster', 'hostmaster', 'abuse'
];

const GENERIC_EMAIL_PREFIXES = [
  'info', 'contact', 'support', 'help', 'sales',
  'admin', 'service', 'hello', 'hi', 'team'
];

const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'guerrillamail.com', 'temp-mail.org',
  '10minutemail.com', 'throwaway.email', 'tempmail.com',
  'trashmail.com', 'getnada.com', 'maildrop.cc'
];

const PHONE_BLACKLIST_PATTERNS = [
  /^0+$/,
  /^1{7,}$/,
  /^(\d)\1{6,}$/,
  /^1234567/,
  /^555-?1212$/,
  /^867-?5309$/,
  /^(123|000|999)-?456-?7890$/
];

// Mock search results for "Andrew Chen" from different engines
const mockSearchResults = {
  google: [
    {
      title: "Andrew Chen - Partner - Andreessen Horowitz (a16z)",
      url: "https://a16z.com/team/andrew-chen/",
      snippet: "Andrew Chen is a partner at Andreessen Horowitz where he focuses on consumer tech, growth, and marketplace investing. Email: andrew@a16z.com. Contact: +1-415-555-0123"
    },
    {
      title: "Andrew Chen - Growth Consultant - Independent",
      url: "https://andrewchen.co/",
      snippet: "Andrew Chen writes about growth, user acquisition, and startups. Contact me at andrew@andrewchen.co or call 415-555-0456 for consulting inquiries."
    },
    {
      title: "Andrew Chen - LinkedIn",
      url: "https://www.linkedin.com/in/andrewchen/",
      snippet: "Partner at Andreessen Horowitz. Previously growth advisor to various startups. San Francisco Bay Area. Contact information available upon connection."
    },
    {
      title: "Andrew Chen - Twitter",
      url: "https://twitter.com/andrewchen",
      snippet: "Andrew Chen (@andrewchen). Partner @a16z. Previously Uber, AppSumo. Writing about growth, startups, and marketplace businesses. andrew.chen@example.com"
    },
    {
      title: "Andrew Chen - AngelList",
      url: "https://angel.co/andrew-chen",
      snippet: "Investor profile for Andrew Chen. Partner at Andreessen Horowitz. Contact: andrew.chen@startup.com, Phone: +1 (415) 555-0789"
    }
  ],
  bing: [
    {
      title: "Andrew Chen - Professional Profile",
      url: "https://www.crunchbase.com/person/andrew-chen",
      snippet: "Andrew Chen is a partner at Andreessen Horowitz. Email contact: andrew.chen@a16z.com. Phone: +1-415-555-0234 for press inquiries."
    },
    {
      title: "Andrew Chen - Blog Posts",
      url: "https://medium.com/@andrewchen",
      snippet: "Andrew Chen's articles on growth and startups. Contact: andrew@medium.com. Business inquiries: 415-555-0567"
    },
    {
      title: "Andrew Chen - Speaking Engagements",
      url: "https://speaker.com/andrew-chen",
      snippet: "Book Andrew Chen for speaking events. Contact agent: speaker@andrewchen.com. Direct line: +1 (415) 555-0890"
    }
  ],
  brave: [
    {
      title: "Andrew Chen - Personal Website",
      url: "https://andrewchen.com",
      snippet: "Andrew Chen's personal site. Partner at a16z. Email: contact@andrewchen.com, Phone: 415-555-0123. Professional inquiries only."
    },
    {
      title: "Andrew Chen - Venture Capital Profile",
      url: "https://venturebeat.com/author/andrew-chen",
      snippet: "Andrew Chen contributes to VentureBeat. Contact: andrew.chen@venturebeat.com. Editorial line: +1-415-555-0345"
    },
    {
      title: "Andrew Chen - Podcast Guest",
      url: "https://podcast.com/episode/andrew-chen-interview",
      snippet: "Interview with Andrew Chen about growth strategies. Contact: podcast@andrewchen.co, Production: 415-555-0678"
    }
  ]
};

function isValidEmail(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  
  const [local, domain] = parts;
  
  if (!local || local.length > 64 || !domain || domain.length > 255) return false;
  
  const localLower = local.toLowerCase();
  if (EMAIL_BLACKLIST_PREFIXES.some(prefix => localLower.startsWith(prefix))) return false;
  
  if (DISPOSABLE_DOMAINS.includes(domain.toLowerCase())) return false;
  
  const domainParts = domain.split('.');
  if (domainParts.length < 2) return false;
  
  const tld = domainParts[domainParts.length - 1];
  if (!tld || tld.length < 2 || tld.length > 24) return false;
  
  if (email.includes('..') || local.startsWith('.') || local.endsWith('.')) return false;
  
  if (!/^[a-z0-9._%+\-]+$/i.test(local)) return false;
  
  return true;
}

function isGenericEmail(email) {
  const localPart = email.split('@')[0]?.toLowerCase() || '';
  return GENERIC_EMAIL_PREFIXES.some(prefix => localPart === prefix || localPart.startsWith(`${prefix}.`));
}

function isValidPhoneStructure(phone) {
  const digitsOnly = phone.replace(/\D/g, '');
  
  if (digitsOnly.length < 7 || digitsOnly.length > 15) return false;
  
  if (PHONE_BLACKLIST_PATTERNS.some(pattern => pattern.test(digitsOnly))) return false;
  
  if (/^(\d)\1+$/.test(digitsOnly)) return false;
  
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

function extractEmailsFromText(text) {
  const emailMatches = Array.from(text.matchAll(EMAIL_REGEX)).map(m => m[0].toLowerCase());
  const validated = emailMatches.filter(email => isValidEmail(email));
  return Array.from(new Set(validated));
}

function extractPhonesFromText(text) {
  const phoneMatches = Array.from(text.matchAll(PHONE_REGEX)).map(m => m[0].trim());
  const validated = [];
  
  for (const phone of phoneMatches) {
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
  
  if (context.domain) {
    const emailDomain = email.split('@')[1]?.toLowerCase();
    const contextDomain = context.domain.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase();
    
    if (emailDomain === contextDomain || emailDomain?.endsWith(`.${contextDomain}`)) {
      score += 30;
      reasons.push('domain-match');
    }
  }
  
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

function runExtractionTest() {
  console.log('='.repeat(80));
  console.log('MANUAL EMAIL/PHONE EXTRACTION TEST FOR "Andrew Chen"');
  console.log('='.repeat(80));
  
  const allResults = [];
  const context = { name: 'Andrew Chen' };
  
  // Process results from each search engine
  for (const [engine, results] of Object.entries(mockSearchResults)) {
    console.log(`\n🔍 ${engine.toUpperCase()} RESULTS:`);
    console.log('-'.repeat(50));
    
    for (const result of results) {
      console.log(`\n📄 ${result.title}`);
      console.log(`🔗 ${result.url}`);
      console.log(`📝 ${result.snippet}`);
      
      // Extract emails and phones from title + snippet
      const combinedText = `${result.title} ${result.snippet}`;
      const emails = extractEmailsFromText(combinedText);
      const phones = extractPhonesFromText(combinedText);
      
      if (emails.length > 0) {
        console.log(`📧 Emails found: ${emails.join(', ')}`);
        const scoredEmails = emails.map(email => scoreEmail(email, context));
        scoredEmails.forEach(scored => {
          console.log(`   - ${scored.value} (score: ${scored.score}, reason: ${scored.reason || 'none'})`);
        });
        allResults.push(...scoredEmails.map(e => ({ ...e, source: engine, url: result.url })));
      }
      
      if (phones.length > 0) {
        console.log(`📞 Phones found: ${phones.join(', ')}`);
        const scoredPhones = phones.map(phone => scorePhone(phone, context));
        scoredPhones.forEach(scored => {
          console.log(`   - ${scored.value} (score: ${scored.score}, reason: ${scored.reason || 'none'})`);
        });
        allResults.push(...scoredPhones.map(p => ({ ...p, source: engine, url: result.url })));
      }
      
      if (emails.length === 0 && phones.length === 0) {
        console.log('❌ No contact info found');
      }
    }
  }
  
  // Summary analysis
  console.log('\n' + '='.repeat(80));
  console.log('EXTRACTION SUMMARY');
  console.log('='.repeat(80));
  
  const emailResults = allResults.filter(r => r.value.includes('@'));
  const phoneResults = allResults.filter(r => !r.value.includes('@'));
  
  console.log(`\n📧 TOTAL EMAILS FOUND: ${emailResults.length}`);
  if (emailResults.length > 0) {
    // Deduplicate and sort by score
    const uniqueEmails = Array.from(new Map(emailResults.map(e => [e.value.toLowerCase(), e])).values());
    uniqueEmails.sort((a, b) => b.score - a.score);
    
    console.log('\nTop emails by score:');
    uniqueEmails.slice(0, 10).forEach((email, i) => {
      console.log(`${i + 1}. ${email.value} (score: ${email.score})`);
      console.log(`   Sources: ${[...new Set(allResults.filter(r => r.value.toLowerCase() === email.value.toLowerCase()).map(r => r.source))].join(', ')}`);
      console.log(`   Reason: ${email.reason || 'none'}`);
    });
  }
  
  console.log(`\n📞 TOTAL PHONES FOUND: ${phoneResults.length}`);
  if (phoneResults.length > 0) {
    // Deduplicate and sort by score
    const uniquePhones = Array.from(new Map(phoneResults.map(p => [p.value, p])).values());
    uniquePhones.sort((a, b) => b.score - a.score);
    
    console.log('\nTop phones by score:');
    uniquePhones.slice(0, 10).forEach((phone, i) => {
      console.log(`${i + 1}. ${phone.value} (score: ${phone.score})`);
      console.log(`   Sources: ${[...new Set(allResults.filter(r => r.value === phone.value).map(r => r.source))].join(', ')}`);
      console.log(`   Reason: ${phone.reason || 'none'}`);
    });
  }
  
  // Test algorithm effectiveness
  console.log('\n' + '='.repeat(80));
  console.log('ALGORITHM EFFECTIVENESS ANALYSIS');
  console.log('='.repeat(80));
  
  const totalContactInfo = emailResults.length + phoneResults.length;
  const highScoreContacts = allResults.filter(r => r.score >= 70).length;
  
  console.log(`\n📊 Statistics:`);
  console.log(`   Total contact info extracted: ${totalContactInfo}`);
  console.log(`   High-score contacts (>=70): ${highScoreContacts}`);
  console.log(`   Extraction success rate: ${totalContactInfo > 0 ? 'SUCCESS' : 'FAILED'}`);
  
  if (totalContactInfo === 0) {
    console.log('\n❌ EXTRACTION ALGORITHM ISSUE DETECTED!');
    console.log('The algorithm failed to extract any contact information from the test data.');
    console.log('This suggests there may be issues with:');
    console.log('1. Regex patterns not matching real-world formats');
    console.log('2. Validation logic being too strict');
    console.log('3. Text processing missing obfuscated formats');
  } else {
    console.log('\n✅ Extraction algorithm appears to be working!');
    console.log(`Found ${emailResults.length} emails and ${phoneResults.length} phone numbers`);
  }
  
  // Check for common issues
  console.log('\n🔍 Common Issues Check:');
  
  // Check if generic emails are being properly scored down
  const genericEmails = emailResults.filter(e => isGenericEmail(e.value));
  if (genericEmails.length > 0) {
    console.log(`   ⚠️  Found ${genericEmails.length} generic emails (should have lower scores)`);
    genericEmails.forEach(e => console.log(`      - ${e.value} (score: ${e.score})`));
  }
  
  // Check for name matching
  const nameMatchEmails = emailResults.filter(e => {
    const emailLocal = e.value.split('@')[0]?.toLowerCase() || '';
    return emailLocal.includes('andrew') || emailLocal.includes('chen');
  });
  if (nameMatchEmails.length > 0) {
    console.log(`   ✅ Found ${nameMatchEmails.length} emails with name matching (should have higher scores)`);
  } else {
    console.log(`   ⚠️  No emails found with name matching - may indicate scoring issue`);
  }
  
  return {
    totalEmails: emailResults.length,
    totalPhones: phoneResults.length,
    highScoreContacts,
    success: totalContactInfo > 0
  };
}

// Run the test
if (require.main === module) {
  const results = runExtractionTest();
  console.log('\n' + '='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80));
  process.exit(results.success ? 0 : 1);
}

module.exports = { runExtractionTest };
