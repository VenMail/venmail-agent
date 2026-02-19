#!/usr/bin/env node

/**
 * Comprehensive SERP simulation test for Andrew Chen
 * Simulates the complete flow: search engines → scraping → extraction → scoring
 * This mirrors what the actual Chrome extension does
 */

// Mock the scrapeResultsFromPage function that runs in the browser context
function scrapeResultsFromPage(engineName, selector) {
  const results = [];
  
  // Mock DOM for different search engines
  const mockDOMs = {
    google: {
      elements: [
        {
          querySelector: (sel) => {
            if (sel.startsWith('a[href')) {
              return { href: 'https://a16z.com/team/andrew-chen/' };
            }
            if (sel === 'h3') {
              return { textContent: 'Andrew Chen - Partner - Andreessen Horowitz (a16z)' };
            }
            if (sel.includes('data-snc') || sel.includes('VwiC3b')) {
              return { 
                textContent: 'Andrew Chen is a partner at Andreessen Horowitz where he focuses on consumer tech, growth, and marketplace investing. Email: andrew@a16z.com. Contact: +1-415-555-0123'
              };
            }
            return null;
          }
        },
        {
          querySelector: (sel) => {
            if (sel.startsWith('a[href')) {
              return { href: 'https://andrewchen.co/' };
            }
            if (sel === 'h3') {
              return { textContent: 'Andrew Chen - Growth Consultant - Independent' };
            }
            if (sel.includes('data-snc') || sel.includes('VwiC3b')) {
              return { 
                textContent: 'Andrew Chen writes about growth, user acquisition, and startups. Contact me at andrew@andrewchen.co or call 415-555-0456 for consulting inquiries.'
              };
            }
            return null;
          }
        },
        {
          querySelector: (sel) => {
            if (sel.startsWith('a[href')) {
              return { href: 'https://www.linkedin.com/in/andrewchen/' };
            }
            if (sel === 'h3') {
              return { textContent: 'Andrew Chen - LinkedIn' };
            }
            if (sel.includes('data-snc') || sel.includes('VwiC3b')) {
              return { 
                textContent: 'Partner at Andreessen Horowitz. Previously growth advisor to various startups. San Francisco Bay Area. Contact information available upon connection.'
              };
            }
            return null;
          }
        }
      ]
    },
    bing: {
      elements: [
        {
          querySelector: (sel) => {
            if (sel === 'h2 a') {
              return { 
                href: 'https://www.crunchbase.com/person/andrew-chen',
                textContent: 'Andrew Chen - Professional Profile'
              };
            }
            if (sel.includes('b_caption')) {
              return { textContent: 'Andrew Chen is a partner at Andreessen Horowitz. Email contact: andrew.chen@a16z.com. Phone: +1-415-555-0234 for press inquiries.' };
            }
            return null;
          }
        },
        {
          querySelector: (sel) => {
            if (sel === 'h2 a') {
              return { 
                href: 'https://medium.com/@andrewchen',
                textContent: 'Andrew Chen - Blog Posts'
              };
            }
            if (sel.includes('b_caption')) {
              return { textContent: 'Andrew Chen\'s articles on growth and startups. Contact: andrew@medium.com. Business inquiries: 415-555-0567' };
            }
            return null;
          }
        }
      ]
    },
    brave: {
      elements: [
        {
          querySelector: (sel) => {
            if (sel.includes('heading-serpresult') || sel.startsWith('a[href^="https')) {
              return { 
                href: 'https://andrewchen.com',
                textContent: 'Andrew Chen - Personal Website'
              };
            }
            if (sel.includes('title') || sel.includes('snippet-description')) {
              return { 
                textContent: 'Andrew Chen\'s personal site. Partner at a16z. Email: contact@andrewchen.com, Phone: 415-555-0123. Professional inquiries only.'
              };
            }
            return { textContent: 'Andrew Chen\'s personal site. Partner at a16z. Email: contact@andrewchen.com, Phone: 415-555-0123. Professional inquiries only.' };
          }
        },
        {
          querySelector: (sel) => {
            if (sel.includes('heading-serpresult') || sel.startsWith('a[href^="https')) {
              return { 
                href: 'https://venturebeat.com/author/andrew-chen',
                textContent: 'Andrew Chen - Venture Capital Profile'
              };
            }
            if (sel.includes('title') || sel.includes('snippet-description')) {
              return { 
                textContent: 'Andrew Chen contributes to VentureBeat. Contact: andrew.chen@venturebeat.com. Editorial line: +1-415-555-0345'
              };
            }
            return { textContent: 'Andrew Chen contributes to VentureBeat. Contact: andrew.chen@venturebeat.com. Editorial line: +1-415-555-0345' };
          }
        }
      ]
    }
  };

  const mockDOM = mockDOMs[engineName];
  if (!mockDOM) {
    return { results: [], blocked: false };
  }

  // Simulate the scraping logic
  for (const element of mockDOM.elements) {
    try {
      let title = '';
      let url = '';
      let snippet = '';

      if (engineName === 'google') {
        const link = element.querySelector('a[href^="http"]');
        if (!link) continue;
        
        url = link.href;
        title = element.querySelector('h3')?.textContent?.trim() || link.textContent?.trim() || '';
        
        const snippetEl = element.querySelector('[data-snc], .VwiC3b, div[style*="-webkit-line-clamp"]');
        snippet = snippetEl?.textContent?.trim() || '';

      } else if (engineName === 'bing') {
        const link = element.querySelector('h2 a');
        if (!link) continue;
        
        url = link.href;
        title = link.textContent?.trim() || '';
        
        const snippetEl = element.querySelector('.b_caption p, .b_attribution, .b_algoSlug');
        snippet = snippetEl?.textContent?.trim() || '';

      } else if (engineName === 'brave') {
        let link = element.querySelector('a.heading-serpresult') || element.querySelector('a[href^="https://"], a[href^="http://"]');
        if (!link) continue;

        url = link.href;
        if (url.includes('search.brave.com') || url.includes('brave.com/search')) continue;

        title = element.querySelector('.title, h3, .snippet-title, .heading-serpresult, .result-title, [data-testid="title"]')?.textContent?.trim()
          || link.textContent?.trim() || '';

        const snippetEl = element.querySelector('.snippet-description, .snippet-content, .body, p, .description, [data-testid="description"]');
        snippet = snippetEl?.textContent?.trim() || element.textContent?.trim().slice(0, 300) || '';

        // Also grab full element text to catch any inline emails/phones
        const fullText = element.textContent || '';
        const emailRegex = /\b[a-z0-9][a-z0-9._%+\-]{0,63}@[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)*\.[a-z]{2,}\b/gi;
        const inlineEmails = Array.from(fullText.matchAll(emailRegex)).map(m => m[0].toLowerCase()).join(' ');
        if (inlineEmails) snippet = `${snippet} ${inlineEmails}`.trim();
      }

      if (url && title) {
        results.push({
          title: title.slice(0, 200),
          url,
          snippet: snippet.slice(0, 500),
          score: 0,
          source: `${engineName}-auto`
        });
      }
    } catch (e) {
      continue;
    }
  }

  return { results, blocked: false };
}

// Extraction utilities (same as serpScan.ts)
const EMAIL_REGEX = /\b[a-z0-9][a-z0-9._%+\-]{0,63}@[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)*\.[a-z]{2,}\b/gi;
const PHONE_REGEX = /(?:\+?\d{1,3}[-\.\s]?)?(?:\(?\d{1,4}\)?[-\.\s]?)?\d{1,4}[-\.\s]?\d{1,4}[-\.\s]?\d{1,9}\b/g;

function isValidEmail(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  
  const [local, domain] = parts;
  if (!local || local.length > 64 || !domain || domain.length > 255) return false;
  
  const blacklist = ['noreply', 'no-reply', 'example', 'test', 'demo', 'user@', 'email@'];
  if (blacklist.some(b => local.toLowerCase().startsWith(b))) return false;
  
  if (email.includes('..') || local.startsWith('.') || local.endsWith('.')) return false;
  if (!/^[a-z0-9._%+\-]+$/i.test(local)) return false;
  
  return true;
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
  if (cleaned.startsWith('+')) return cleaned;
  if (digitCount === 10) return `+1${cleaned}`;
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

function runSerpSimulation() {
  console.log('='.repeat(80));
  console.log('COMPLETE SERP SCRAPING SIMULATION FOR "Andrew Chen"');
  console.log('='.repeat(80));
  
  const searchEngines = ['google', 'bing', 'brave'];
  const allHighlights = [];
  const allExtractedContacts = [];
  
  // Simulate scraping each search engine
  for (const engine of searchEngines) {
    console.log(`\n🔍 SCRAPING ${engine.toUpperCase()}:`);
    console.log('-'.repeat(50));
    
    // Simulate the scrapeResultsFromPage function
    const scrapeResult = scrapeResultsFromPage(engine, 'div.g, div[data-sokoban-container]');
    const highlights = scrapeResult.results;
    
    console.log(`📄 Found ${highlights.length} search results`);
    
    // Process each result
    for (const highlight of highlights) {
      console.log(`\n🔗 ${highlight.title}`);
      console.log(`   URL: ${highlight.url}`);
      console.log(`   Snippet: ${highlight.snippet.substring(0, 150)}...`);
      
      // Extract emails and phones directly from SERP snippets (as done in serpScan.ts)
      const combinedText = `${highlight.title} ${highlight.snippet ?? ''}`;
      const emails = extractEmailsFromText(combinedText);
      const phones = extractPhonesFromText(combinedText);
      
      if (emails.length > 0) {
        console.log(`   📧 Emails in snippet: ${emails.join(', ')}`);
        allExtractedContacts.push(...emails.map(e => ({ type: 'email', value: e, source: engine, url: highlight.url })));
      }
      
      if (phones.length > 0) {
        console.log(`   📞 Phones in snippet: ${phones.join(', ')}`);
        allExtractedContacts.push(...phones.map(p => ({ type: 'phone', value: p, source: engine, url: highlight.url })));
      }
      
      if (emails.length === 0 && phones.length === 0) {
        console.log(`   ❌ No contact info in snippet`);
      }
    }
    
    allHighlights.push(...highlights);
  }
  
  // Summary analysis
  console.log('\n' + '='.repeat(80));
  console.log('SERP SCRAPING SUMMARY');
  console.log('='.repeat(80));
  
  const emails = allExtractedContacts.filter(c => c.type === 'email');
  const phones = allExtractedContacts.filter(c => c.type === 'phone');
  
  console.log(`\n📊 TOTAL RESULTS:`);
  console.log(`   Search results scraped: ${allHighlights.length}`);
  console.log(`   Emails extracted from SERPs: ${emails.length}`);
  console.log(`   Phones extracted from SERPs: ${phones.length}`);
  console.log(`   Total contact info found: ${allExtractedContacts.length}`);
  
  if (emails.length > 0) {
    console.log(`\n📧 EMAILS FOUND IN SERPS:`);
    const uniqueEmails = Array.from(new Map(emails.map(e => [e.value.toLowerCase(), e])).values());
    uniqueEmails.forEach((email, i) => {
      const sources = [...new Set(allExtractedContacts.filter(c => c.value.toLowerCase() === email.value.toLowerCase()).map(c => c.source))];
      console.log(`${i + 1}. ${email.value} (found in: ${sources.join(', ')})`);
    });
  }
  
  if (phones.length > 0) {
    console.log(`\n📞 PHONES FOUND IN SERPS:`);
    const uniquePhones = Array.from(new Map(phones.map(p => [p.value, p])).values());
    uniquePhones.forEach((phone, i) => {
      const sources = [...new Set(allExtractedContacts.filter(c => c.value === phone.value).map(c => c.source))];
      console.log(`${i + 1}. ${phone.value} (found in: ${sources.join(', ')})`);
    });
  }
  
  // Test algorithm effectiveness
  console.log('\n' + '='.repeat(80));
  console.log('ALGORITHM EFFECTIVENESS ANALYSIS');
  console.log('='.repeat(80));
  
  const success = allExtractedContacts.length > 0;
  const extractionRate = (allExtractedContacts.length / allHighlights.length) * 100;
  
  console.log(`\n📈 PERFORMANCE METRICS:`);
  console.log(`   Contact extraction rate: ${extractionRate.toFixed(1)}%`);
  console.log(`   Algorithm success: ${success ? '✅ WORKING' : '❌ FAILED'}`);
  
  if (!success) {
    console.log(`\n❌ ALGORITHM ISSUE DETECTED!`);
    console.log(`The SERP extraction failed to find any contact information.`);
    console.log(`This indicates potential issues with:`);
    console.log(`1. Regex patterns not matching real SERP formats`);
    console.log(`2. Text processing missing contact patterns`);
    console.log(`3. Validation logic being too restrictive`);
  } else {
    console.log(`\n✅ SERP extraction algorithm is working correctly!`);
    console.log(`Successfully extracted contact info from search engine results.`);
  }
  
  // Check for specific patterns that should work
  console.log(`\n🔍 PATTERN VERIFICATION:`);
  
  // Check if name-based emails are being found
  const nameBasedEmails = emails.filter(e => {
    const local = e.value.split('@')[0]?.toLowerCase() || '';
    return local.includes('andrew') || local.includes('chen');
  });
  
  if (nameBasedEmails.length > 0) {
    console.log(`   ✅ Name-based emails found: ${nameBasedEmails.length}`);
  } else {
    console.log(`   ⚠️  No name-based emails detected (potential scoring issue)`);
  }
  
  // Check phone format handling
  const formattedPhones = phones.filter(p => p.value && p.value.startsWith('+'));
  if (formattedPhones.length > 0) {
    console.log(`   ✅ International phone format working: ${formattedPhones.length}`);
  } else {
    console.log(`   ⚠️  No international phone formats detected`);
  }
  
  return {
    totalResults: allHighlights.length,
    totalEmails: emails.length,
    totalPhones: phones.length,
    extractionRate,
    success
  };
}

// Run the simulation
if (require.main === module) {
  const results = runSerpSimulation();
  console.log('\n' + '='.repeat(80));
  console.log('SERP SIMULATION COMPLETE');
  console.log('='.repeat(80));
  process.exit(results.success ? 0 : 1);
}

module.exports = { runSerpSimulation };
