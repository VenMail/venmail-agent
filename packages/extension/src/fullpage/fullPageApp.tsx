import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  ContactLookup,
  ExtensionResponseMessage,
  ReputationResponse,
  SearchHistoryEntry
} from '@venmail/shared';

import { safeSendMessage } from '../shared/messaging';
import { buildRequestKey } from '@venmail/shared';
import { SearchIcon, ExternalLink, Download, Trash2, Clock, User, Mail, Building } from 'lucide-react';
import './fullPage.css';

interface SearchHistoryEntryWithId extends SearchHistoryEntry {
  id: string;
}

export function FullPageApp(): JSX.Element {
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntryWithId[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [selectedResult, setSelectedResult] = useState<SearchHistoryEntryWithId | null>(null);
  const [status, setStatus] = useState({ message: 'Ready', variant: 'info' as 'info' | 'success' | 'error' });

  // Load search history on mount
  useEffect(() => {
    loadSearchHistory();
  }, []);

  const loadSearchHistory = useCallback(() => {
    setIsLoading(true);
    safeSendMessage({ action: 'getSearchHistory' }, (response: ExtensionResponseMessage) => {
      setIsLoading(false);
      if (chrome.runtime.lastError) {
        setStatus({ message: chrome.runtime.lastError.message || 'Failed to load history', variant: 'error' });
        return;
      }

      if (response?.success && response.searchHistory) {
        const historyWithIds = response.searchHistory.map((entry, index) => ({
          ...entry,
          id: `${entry.timestamp}-${index}`
        }));
        setSearchHistory(historyWithIds.sort((a, b) => b.timestamp - a.timestamp));
      } else {
        setStatus({ message: 'No search history found', variant: 'info' });
      }
    });
  }, []);

  const handleSearch = useCallback((query: string) => {
    if (!query.trim()) return;

    setIsSearching(true);
    setStatus({ message: 'Searching...', variant: 'info' });

    // Parse the query to determine lookup parameters
    const lookup = parseQueryToLookup(query.trim());
    
    safeSendMessage({
      action: 'fetchContactInfo',
      ...lookup
    }, (response: ExtensionResponseMessage) => {
      setIsSearching(false);
      
      if (chrome.runtime.lastError) {
        setStatus({ message: chrome.runtime.lastError.message || 'Search failed', variant: 'error' });
        return;
      }

      if (response?.success && response.data) {
        // Add to search history
        const historyEntry: SearchHistoryEntry = {
          query: query.trim(),
          lookup,
          response: response.data,
          timestamp: Date.now(),
          fromCache: Boolean(response.meta?.fromCache)
        };

        safeSendMessage({
          action: 'saveSearchHistoryEntry',
          entry: historyEntry
        }, () => {
          loadSearchHistory(); // Refresh history
        });

        setSelectedResult({
          ...historyEntry,
          id: `${historyEntry.timestamp}-new`
        });
        setStatus({ message: 'Search completed successfully', variant: 'success' });
      } else {
        setStatus({ message: response?.error || 'Search failed', variant: 'error' });
      }
    });
  }, [loadSearchHistory]);

  const parseQueryToLookup = (query: string): ContactLookup => {
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const domainRegex = /\b([A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+)\b/i;
    
    const emailMatch = query.match(emailRegex);
    const domainMatch = query.match(domainRegex);
    
    const lookup: ContactLookup = {
      name: '',
      email: '',
      domain: '',
      company: ''
    };

    if (emailMatch) {
      lookup.email = emailMatch[0].toLowerCase();
      lookup.domain = lookup.email.split('@')[1];
    } else if (domainMatch) {
      lookup.domain = domainMatch[1].toLowerCase();
    }

    // Extract name from query (simple heuristic)
    const words = query.split(/\s+/).filter(word => 
      !word.includes('@') && 
      !domainRegex.test(word) &&
      word.length > 1
    );
    
    if (words.length >= 2 && words.length <= 4) {
      lookup.name = words.slice(0, 3).join(' ');
      lookup.company = words.slice(-2).join(' ');
    } else if (words.length === 1) {
      lookup.name = words[0];
    }

    return lookup;
  };

  const handleExportHistory = useCallback(() => {
    if (searchHistory.length === 0) return;

    const exportData = {
      exportedAt: new Date().toISOString(),
      totalEntries: searchHistory.length,
      entries: searchHistory.map(({ id, ...entry }) => entry)
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `venmail-search-history-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus({ message: 'Search history exported', variant: 'success' });
  }, [searchHistory]);

  const handleClearHistory = useCallback(() => {
    if (!confirm('Are you sure you want to clear all search history?')) return;

    safeSendMessage({ action: 'clearSearchHistory' }, (response: ExtensionResponseMessage) => {
      if (chrome.runtime.lastError) {
        setStatus({ message: chrome.runtime.lastError.message || 'Failed to clear history', variant: 'error' });
        return;
      }

      if (response?.success) {
        setSearchHistory([]);
        setSelectedResult(null);
        setStatus({ message: 'Search history cleared', variant: 'success' });
      } else {
        setStatus({ message: response?.error || 'Failed to clear history', variant: 'error' });
      }
    });
  }, []);

  const handleDeleteEntry = useCallback((entryId: string) => {
    const entry = searchHistory.find(e => e.id === entryId);
    if (!entry) return;

    safeSendMessage({
      action: 'deleteSearchHistoryEntry',
      timestamp: entry.timestamp
    }, (response: ExtensionResponseMessage) => {
      if (chrome.runtime.lastError) {
        setStatus({ message: chrome.runtime.lastError.message || 'Failed to delete entry', variant: 'error' });
        return;
      }

      if (response?.success) {
        setSearchHistory(prev => prev.filter(e => e.id !== entryId));
        if (selectedResult?.id === entryId) {
          setSelectedResult(null);
        }
        setStatus({ message: 'Entry deleted', variant: 'success' });
      } else {
        setStatus({ message: response?.error || 'Failed to delete entry', variant: 'error' });
      }
    });
  }, [searchHistory, selectedResult]);

  const filteredHistory = useMemo(() => {
    if (!searchQuery.trim()) return searchHistory;
    
    const query = searchQuery.toLowerCase();
    return searchHistory.filter(entry => 
      entry.query.toLowerCase().includes(query) ||
      entry.lookup.name?.toLowerCase().includes(query) ||
      entry.lookup.email?.toLowerCase().includes(query) ||
      entry.lookup.company?.toLowerCase().includes(query) ||
      entry.lookup.domain?.toLowerCase().includes(query)
    );
  }, [searchHistory, searchQuery]);

  return (
    <div className="fullpage-container">
      <header className="fullpage-header">
        <div className="header-content">
          <div className="logo">
            <h1>Venmail Agent</h1>
            <span className="subtitle">Full Page Interface</span>
          </div>
          <div className="header-actions">
            <button 
              className="btn btn-secondary"
              onClick={handleExportHistory}
              disabled={searchHistory.length === 0}
              title="Export search history"
            >
              <Download size={16} /> Export
            </button>
            <button 
              className="btn btn-danger"
              onClick={handleClearHistory}
              disabled={searchHistory.length === 0}
              title="Clear all history"
            >
              <Trash2 size={16} /> Clear All
            </button>
          </div>
        </div>
      </header>

      <main className="fullpage-main">
        <section className="search-section">
          <div className="search-container">
            <div className="search-input-group">
              <input
                type="text"
                placeholder="Search by name, email, company, or domain..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch(searchQuery)}
                className="search-input"
              />
              <button
                onClick={() => handleSearch(searchQuery)}
                disabled={isSearching || !searchQuery.trim()}
                className="search-button"
              >
                <SearchIcon size={20} />
                {isSearching ? 'Searching...' : 'Search'}
              </button>
            </div>
            {status.message && (
              <div className={`status status-${status.variant}`}>
                {status.message}
              </div>
            )}
          </div>
        </section>

        <div className="content-grid">
          <section className="history-section">
            <h2>Search History</h2>
            {isLoading ? (
              <div className="loading">Loading search history...</div>
            ) : filteredHistory.length === 0 ? (
              <div className="empty-state">
                <Clock size={48} />
                <p>No search history found</p>
                <small>Start by searching for contacts above</small>
              </div>
            ) : (
              <div className="history-list">
                {filteredHistory.map((entry) => (
                  <div
                    key={entry.id}
                    className={`history-item ${selectedResult?.id === entry.id ? 'selected' : ''}`}
                    onClick={() => setSelectedResult(entry)}
                  >
                    <div className="history-item-header">
                      <span className="history-query">{entry.query}</span>
                      <div className="history-item-actions">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteEntry(entry.id);
                          }}
                          className="btn-icon btn-danger"
                          title="Delete entry"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="history-item-meta">
                      <span className="timestamp">
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>
                      {entry.fromCache && <span className="cache-badge">From Cache</span>}
                    </div>
                    <div className="history-item-details">
                      {entry.lookup.name && (
                        <div className="detail-row">
                          <User size={14} />
                          <span>{entry.lookup.name}</span>
                        </div>
                      )}
                      {entry.lookup.email && (
                        <div className="detail-row">
                          <Mail size={14} />
                          <span>{entry.lookup.email}</span>
                        </div>
                      )}
                      {entry.lookup.company && (
                        <div className="detail-row">
                          <Building size={14} />
                          <span>{entry.lookup.company}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="result-section">
            <h2>Search Results</h2>
            {selectedResult ? (
              <div className="result-detail">
                <div className="result-header">
                  <h3>{selectedResult.query}</h3>
                  <div className="result-meta">
                    <span className="timestamp">
                      {new Date(selectedResult.timestamp).toLocaleString()}
                    </span>
                    {selectedResult.fromCache && <span className="cache-badge">From Cache</span>}
                  </div>
                </div>
                
                <div className="reputation-summary">
                  <h4>Reputation Score: {selectedResult.response.reputation?.score || 'N/A'}</h4>
                  <p>Status: {selectedResult.response.reputation?.status || 'N/A'}</p>
                </div>

                {selectedResult.response.additionalData && (
                  <div className="contact-info">
                    <h4>Contact Information</h4>
                    {selectedResult.response.additionalData.jobTitle && (
                      <p><strong>Title:</strong> {selectedResult.response.additionalData.jobTitle}</p>
                    )}
                    {selectedResult.response.additionalData.emailAddresses && selectedResult.response.additionalData.emailAddresses.length > 0 && (
                      <p><strong>Emails:</strong> {selectedResult.response.additionalData.emailAddresses.join(', ')}</p>
                    )}
                    {selectedResult.response.additionalData.phoneNumbers && selectedResult.response.additionalData.phoneNumbers.length > 0 && (
                      <p><strong>Phones:</strong> {selectedResult.response.additionalData.phoneNumbers.join(', ')}</p>
                    )}
                    {selectedResult.response.companyInfo && (
                      <>
                        <p><strong>Company:</strong> {selectedResult.response.companyInfo.name}</p>
                        <p><strong>Website:</strong> {selectedResult.response.companyInfo.website}</p>
                        {selectedResult.response.companyInfo.industry && (
                          <p><strong>Industry:</strong> {selectedResult.response.companyInfo.industry}</p>
                        )}
                      </>
                    )}
                  </div>
                )}

                {selectedResult.response.reputationSignals && (
                  <div className="reputation-signals">
                    <h4>Reputation Signals</h4>
                    <pre className="signals-json">
                      {JSON.stringify(selectedResult.response.reputationSignals, null, 2)}
                    </pre>
                  </div>
                )}

                <div className="result-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      // Export this specific result
                      const exportData = {
                        exportedAt: new Date().toISOString(),
                        entry: selectedResult
                      };
                      
                      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `venmail-result-${selectedResult.query.replace(/[^a-z0-9]/gi, '_')}.json`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <ExternalLink size={16} /> Export Result
                  </button>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <SearchIcon size={48} />
                <p>Select a search entry to view results</p>
                <small>Choose from your search history on the left</small>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
