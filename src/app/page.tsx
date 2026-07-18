'use client';

import React, { useEffect, useState, useRef } from 'react';

interface Message {
  id: string;
  sender: string;
  text: string;
  direction: 'incoming' | 'outgoing';
  created_at: string;
}

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface DatesheetState {
  status: 'not_launched' | 'launched';
  lastChecked: string | null;
  totalNotified: number;
}

type Tab = 'inbox' | 'logs';

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedSender, setSelectedSender] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [pollingActive, setPollingActive] = useState<boolean>(true);
  const [stats, setStats] = useState<any>(null);
  const [datesheet, setDatesheet] = useState<DatesheetState | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('inbox');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryStatus, setRetryStatus] = useState<{ [key: string]: 'success' | 'error' | null }>({});

  const handleRetry = async (msg: Message) => {
    setRetryingId(msg.id);
    setRetryStatus(prev => ({ ...prev, [msg.id]: null }));
    try {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: `retry_${msg.id}_${Date.now()}`,
                      from: msg.sender,
                      type: 'text',
                      text: {
                        body: msg.text
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]
      };

      const res = await fetch('/api/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        setRetryStatus(prev => ({ ...prev, [msg.id]: 'success' }));
        setTimeout(() => {
          fetchMessages();
          fetchLogs();
          fetchStats();
        }, 1500);
      } else {
        setRetryStatus(prev => ({ ...prev, [msg.id]: 'error' }));
      }
    } catch (e) {
      setRetryStatus(prev => ({ ...prev, [msg.id]: 'error' }));
    } finally {
      setRetryingId(null);
    }
  };

  const fetchMessages = async () => {
    try {
      const res = await fetch('/api/messages');
      if (res.ok) setMessages(await res.json());
    } catch (e) {} finally { setLoading(false); }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/stats');
      if (res.ok) setStats(await res.json());
    } catch (e) {}
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      if (res.ok) setLogs(await res.json());
    } catch (e) {}
  };

  const fetchDatesheet = async () => {
    try {
      const res = await fetch('/api/datesheet');
      if (res.ok) setDatesheet(await res.json());
    } catch (e) {}
  };

  useEffect(() => {
    fetchMessages();
    fetchStats();
    fetchLogs();
    fetchDatesheet();
  }, []);

  useEffect(() => {
    if (!pollingActive) return;
    const interval = setInterval(() => {
      fetchMessages();
      fetchStats();
      fetchLogs();
      fetchDatesheet();
    }, 5000);
    return () => clearInterval(interval);
  }, [pollingActive]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const senders = Array.from(new Set(messages.map(m => m.sender)));

  const filteredMessages = messages.filter(m => {
    const matchesSender = selectedSender === 'all' || m.sender === selectedSender;
    const matchesSearch = m.text.toLowerCase().includes(searchQuery.toLowerCase()) || m.sender.includes(searchQuery);
    return matchesSender && matchesSearch;
  });

  const formatTime = (d: string) => {
    try { const date = new Date(d); return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' • ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch { return d; }
  };
  const formatGB = (b: number) => b ? (b / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : '0 GB';
  const formatUptime = (s: number) => { if (!s) return '0m'; const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m'; };

  const levelColor = (l: string) => l === 'error' ? 'text-rose-400' : l === 'warn' ? 'text-amber-400' : 'text-emerald-400';
  const levelBg = (l: string) => l === 'error' ? 'bg-rose-500/10' : l === 'warn' ? 'bg-amber-500/10' : 'bg-emerald-500/10';

  return (
    <div className="flex h-screen w-screen bg-zinc-950 font-sans text-zinc-100 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-80 border-r border-zinc-800 bg-zinc-900/50 flex flex-col h-full">
        {/* Header */}
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${pollingActive ? 'bg-emerald-400' : 'bg-amber-400'} opacity-75`}></span>
              <span className={`relative inline-flex rounded-full h-3 w-3 ${pollingActive ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
            </span>
            <h1 className="font-semibold text-lg tracking-tight">LMS Agent</h1>
          </div>
          <button onClick={() => { fetchMessages(); fetchStats(); fetchLogs(); fetchDatesheet(); }} className="p-1.5 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-zinc-100 transition-colors">⟳</button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-zinc-800">
          <button onClick={() => setActiveTab('inbox')} className={`flex-1 py-2.5 text-sm font-medium transition-colors ${activeTab === 'inbox' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-zinc-500 hover:text-zinc-300'}`}>Inbox</button>
          <button onClick={() => setActiveTab('logs')} className={`flex-1 py-2.5 text-sm font-medium transition-colors ${activeTab === 'logs' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-zinc-500 hover:text-zinc-300'}`}>Logs</button>
        </div>

        {activeTab === 'inbox' ? (
          <>
            {/* Search */}
            <div className="p-3 border-b border-zinc-800">
              <input type="text" placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700" />
            </div>
            {/* Participants */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              <button onClick={() => setSelectedSender('all')} className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center justify-between text-sm ${selectedSender === 'all' ? 'bg-blue-600 text-white font-medium' : 'hover:bg-zinc-800 text-zinc-300'}`}>
                <span>All Chats</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${selectedSender === 'all' ? 'bg-blue-700' : 'bg-zinc-800 text-zinc-400'}`}>{messages.length}</span>
              </button>
              <div className="pt-2 pb-1 px-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">Active</div>
              {senders.map(sender => {
                const count = messages.filter(m => m.sender === sender).length;
                const latest = messages.find(m => m.sender === sender)?.text || '';
                return (
                  <button key={sender} onClick={() => setSelectedSender(sender)} className={`w-full text-left px-3 py-3 rounded-lg flex flex-col gap-1 ${selectedSender === sender ? 'bg-zinc-800 border-l-4 border-blue-500' : 'hover:bg-zinc-800/60'}`}>
                    <div className="flex justify-between w-full"><span className="font-medium text-sm">{sender}</span><span className="text-[10px] bg-zinc-950 text-zinc-400 px-1.5 py-0.5 rounded">{count}</span></div>
                    <span className="text-xs text-zinc-500 truncate max-w-[240px]">{latest}</span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          /* Logs Panel */
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {logs.length === 0 ? (
              <div className="text-xs text-zinc-500 text-center py-8">No logs yet. Logs appear when the bot processes messages.</div>
            ) : (
              logs.map((log, i) => (
                <div key={i} className={`px-3 py-2 rounded-lg text-xs ${levelBg(log.level)}`}>
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`font-bold uppercase ${levelColor(log.level)}`}>{log.level}</span>
                    <span className="text-zinc-600">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className="text-zinc-300 break-all">{log.message}</p>
                </div>
              ))
            )}
          </div>
        )}

        {/* datesheet.vu.edu.pk Status Monitor Widget */}
        <div className="p-4 border-t border-zinc-800 bg-zinc-950/40">
          <div className="text-xs font-semibold tracking-wider text-zinc-500 uppercase mb-3">Datesheet Monitor</div>
          {datesheet ? (
            <div className="space-y-2 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-zinc-400">Portal Status</span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                  datesheet.status === 'launched' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                }`}>
                  {datesheet.status === 'launched' ? '🚀 Launched' : '⏳ Not Launched'}
                </span>
              </div>
              <div className="flex justify-between items-center text-zinc-400">
                <span>Notified Students</span>
                <span className="text-zinc-200 font-semibold">{datesheet.totalNotified}</span>
              </div>
              <div className="flex justify-between items-center text-zinc-400">
                <span>Last Checked</span>
                <span className="text-zinc-300 truncate max-w-[120px]" title={datesheet.lastChecked ? new Date(datesheet.lastChecked).toLocaleString() : 'Never'}>
                  {datesheet.lastChecked ? new Date(datesheet.lastChecked).toLocaleTimeString() : 'Never'}
                </span>
              </div>
            </div>
          ) : (
            <div className="text-zinc-600 text-xs text-center">Loading monitor status...</div>
          )}
        </div>

        {/* Server Stats */}
        <div className="p-4 border-t border-zinc-800 bg-zinc-950/20">
          <div className="text-xs font-semibold tracking-wider text-zinc-500 uppercase mb-3">Server Health</div>
          {stats ? (
            <div className="space-y-3 text-xs">
              <div>
                <div className="flex justify-between text-zinc-400 mb-1"><span>CPU</span><span className="font-semibold text-zinc-200">{stats.cpuUsage}%</span></div>
                <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all duration-500 ${stats.cpuUsage > 80 ? 'bg-rose-500' : stats.cpuUsage > 50 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${stats.cpuUsage}%` }} /></div>
              </div>
              <div>
                <div className="flex justify-between text-zinc-400 mb-1"><span>Memory ({formatGB(stats.totalMem - stats.freeMem)}/{formatGB(stats.totalMem)})</span><span className="font-semibold text-zinc-200">{stats.memUsage}%</span></div>
                <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all duration-500 ${stats.memUsage > 85 ? 'bg-rose-500' : stats.memUsage > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${stats.memUsage}%` }} /></div>
              </div>
              <div className="flex justify-between text-zinc-400 pt-1"><span>Uptime</span><span className="text-zinc-200">{formatUptime(stats.uptime)}</span></div>
              <div className="flex justify-between text-zinc-400"><span>Platform</span><span className="text-zinc-300 capitalize">{stats.platform} ({stats.arch})</span></div>
            </div>
          ) : <div className="text-zinc-600 text-xs text-center">Loading...</div>}
        </div>

        {/* Polling Toggle */}
        <div className="p-3 border-t border-zinc-800 bg-zinc-950/80 flex items-center justify-between text-xs text-zinc-400">
          <span>Auto-Refresh</span>
          <button onClick={() => setPollingActive(!pollingActive)} className={`relative inline-flex h-5 w-9 items-center rounded-full ${pollingActive ? 'bg-blue-600' : 'bg-zinc-800'}`}>
            <span style={{ transform: pollingActive ? 'translateX(18px)' : 'translateX(4px)' }} className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform" />
          </button>
        </div>
      </aside>

      {/* Main Panel */}
      <main className="flex-1 flex flex-col h-full bg-zinc-950">
        <header className="h-[60px] border-b border-zinc-800 px-6 flex items-center justify-between">
          <div>
            <h2 className="font-semibold">{selectedSender === 'all' ? 'All Conversations' : `Chat: ${selectedSender}`}</h2>
            <p className="text-xs text-zinc-500">{filteredMessages.length} message(s)</p>
          </div>
          <span className="text-xs bg-zinc-900 border border-zinc-800 px-2.5 py-1 rounded-md text-zinc-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>Online
          </span>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading ? (
            <div className="h-full flex items-center justify-center text-sm text-zinc-500">
              <svg className="animate-spin h-5 w-5 mr-2 text-zinc-400" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
              Loading...
            </div>
          ) : filteredMessages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-2">
              <h3 className="font-semibold text-zinc-400">No Messages</h3>
              <p className="text-xs">Messages will appear here as users interact with the bot.</p>
            </div>
          ) : (
            <>
              {[...filteredMessages].reverse().map((msg) => (
                <div key={msg.id} className={`flex w-full ${msg.direction === 'incoming' ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-md flex flex-col ${msg.direction === 'incoming' ? 'items-start' : 'items-end'} gap-1`}>
                    {selectedSender === 'all' && <span className="text-[10px] text-zinc-500 px-1">{msg.direction === 'incoming' ? msg.sender : `Bot → ${msg.sender}`}</span>}
                    <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${msg.direction === 'incoming' ? 'bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-tl-none' : 'bg-blue-600 text-white rounded-tr-none'}`}>
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                    </div>
                    <div className="flex items-center gap-2 mt-1 px-1">
                      <span className="text-[10px] text-zinc-600">{formatTime(msg.created_at)}</span>
                      {msg.direction === 'incoming' && (
                        <button
                          onClick={() => handleRetry(msg)}
                          disabled={retryingId !== null}
                          className={`text-[10px] font-semibold flex items-center gap-1 px-1.5 py-0.5 rounded transition-all duration-200 cursor-pointer ${
                            retryingId === msg.id
                              ? 'text-amber-400 bg-amber-500/10 cursor-not-allowed'
                              : retryStatus[msg.id] === 'success'
                              ? 'text-emerald-400 bg-emerald-500/10'
                              : retryStatus[msg.id] === 'error'
                              ? 'text-rose-400 bg-rose-500/10 hover:bg-rose-500/20'
                              : 'text-zinc-500 hover:text-blue-400 hover:bg-zinc-850/50'
                          }`}
                        >
                          {retryingId === msg.id ? (
                            <>
                              <svg className="animate-spin h-2.5 w-2.5" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                              </svg>
                              Retrying...
                            </>
                          ) : retryStatus[msg.id] === 'success' ? (
                            <>✓ Retried</>
                          ) : retryStatus[msg.id] === 'error' ? (
                            <>✗ Failed</>
                          ) : (
                            <>↺ Retry</>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
