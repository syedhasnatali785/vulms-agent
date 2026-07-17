'use client';

import React, { useEffect, useState } from 'react';

interface Message {
  id: string;
  sender: string;
  text: string;
  direction: 'incoming' | 'outgoing';
  created_at: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedSender, setSelectedSender] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [pollingActive, setPollingActive] = useState<boolean>(true);

  // Fetch messages from API
  const fetchMessages = async () => {
    try {
      const response = await fetch('/api/messages');
      if (response.ok) {
        const data = await response.json();
        setMessages(data);
      }
    } catch (error) {
      console.error('Error fetching messages:', error);
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchMessages();
  }, []);

  // Poll for new messages every 5 seconds if active
  useEffect(() => {
    if (!pollingActive) return;
    const interval = setInterval(() => {
      fetchMessages();
    }, 5000);
    return () => clearInterval(interval);
  }, [pollingActive]);

  // Extract unique senders (participants) from messages
  const senders = Array.from(new Set(messages.map(m => m.sender)));

  // Filter messages based on selected participant and search query
  const filteredMessages = messages.filter(m => {
    const matchesSender = selectedSender === 'all' || m.sender === selectedSender;
    const matchesSearch = m.text.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          m.sender.includes(searchQuery);
    return matchesSender && matchesSearch;
  });

  // Helper to format date nicely
  const formatTime = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' • ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch (e) {
      return dateStr;
    }
  };

  return (
    <div className="flex h-screen w-screen bg-zinc-950 font-sans text-zinc-100 overflow-hidden">
      {/* Sidebar - Chat Participants */}
      <aside className="w-80 border-r border-zinc-800 bg-zinc-900/50 flex flex-col h-full">
        {/* Sidebar Header */}
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${pollingActive ? 'bg-emerald-400' : 'bg-amber-400'} opacity-75`}></span>
              <span className={`relative inline-flex rounded-full h-3 w-3 ${pollingActive ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
            </span>
            <h1 className="font-semibold text-lg tracking-tight">LMS Inbox Channel</h1>
          </div>
          <button 
            onClick={fetchMessages} 
            title="Refresh feed"
            className="p-1.5 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M9 11l3-3 3 3m-3-3v12" />
            </svg>
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-3 border-b border-zinc-800">
          <div className="relative">
            <input
              type="text"
              placeholder="Search sender or keywords..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700 transition-colors"
            />
          </div>
        </div>

        {/* Participants List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <button
            onClick={() => setSelectedSender('all')}
            className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center justify-between text-sm transition-all ${
              selectedSender === 'all' 
                ? 'bg-blue-600 text-white font-medium shadow-md shadow-blue-600/10' 
                : 'hover:bg-zinc-800 text-zinc-300'
            }`}
          >
            <span>All Conversations</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${selectedSender === 'all' ? 'bg-blue-700 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
              {messages.length}
            </span>
          </button>

          <div className="pt-2 pb-1 px-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
            Active Chats
          </div>

          {senders.length === 0 ? (
            <div className="text-xs text-zinc-500 px-3 py-4 text-center">No active chats found</div>
          ) : (
            senders.map((sender) => {
              const senderMsgs = messages.filter(m => m.sender === sender);
              const latestMsg = senderMsgs[0]?.text || '';
              
              return (
                <button
                  key={sender}
                  onClick={() => setSelectedSender(sender)}
                  className={`w-full text-left px-3 py-3 rounded-lg flex flex-col gap-1 transition-all ${
                    selectedSender === sender 
                      ? 'bg-zinc-800 text-white border-l-4 border-blue-500' 
                      : 'hover:bg-zinc-800/60 text-zinc-300'
                  }`}
                >
                  <div className="flex justify-between items-center w-full">
                    <span className="font-medium text-sm text-zinc-100">{sender}</span>
                    <span className="text-[10px] bg-zinc-950 text-zinc-400 px-1.5 py-0.5 rounded">
                      {senderMsgs.length}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-500 truncate w-full max-w-[240px]">
                    {latestMsg}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Polling Indicator Footer */}
        <div className="p-3 border-t border-zinc-800 bg-zinc-950/80 flex items-center justify-between text-xs text-zinc-400">
          <span>Live Auto-Refresh</span>
          <button
            onClick={() => setPollingActive(!pollingActive)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
              pollingActive ? 'bg-blue-600' : 'bg-zinc-800'
            }`}
          >
            <span
              style={{ transform: pollingActive ? 'translateX(18px)' : 'translateX(4px)' }}
              className="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform"
            />
          </button>
        </div>
      </aside>

      {/* Main Panel - Conversation History */}
      <main className="flex-1 flex flex-col h-full bg-zinc-950">
        {/* Main Header */}
        <header className="h-[60px] border-b border-zinc-800 px-6 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-zinc-100">
              {selectedSender === 'all' ? 'All Conversations Log' : `Chat history for: ${selectedSender}`}
            </h2>
            <p className="text-xs text-zinc-500">
              Showing {filteredMessages.length} message(s)
            </p>
          </div>
          <div className="flex gap-2">
            <span className="text-xs bg-zinc-900 border border-zinc-800 px-2.5 py-1 rounded-md text-zinc-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              Active Agent Online
            </span>
          </div>
        </header>

        {/* Messages Stream */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading ? (
            <div className="h-full flex items-center justify-center text-sm text-zinc-500">
              <div className="flex flex-col items-center gap-2">
                <svg className="animate-spin h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                <span>Retrieving conversation thread...</span>
              </div>
            </div>
          ) : filteredMessages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500 max-w-sm mx-auto gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <h3 className="font-semibold text-zinc-400">No Messages Logged</h3>
              <p className="text-xs">Incoming and outgoing text messages will appear here in real-time as users interact with the bot.</p>
            </div>
          ) : (
            filteredMessages.map((msg) => {
              const isIncoming = msg.direction === 'incoming';
              
              return (
                <div 
                  key={msg.id} 
                  className={`flex w-full ${isIncoming ? 'justify-start' : 'justify-end'}`}
                >
                  <div className={`max-w-md flex flex-col ${isIncoming ? 'items-start' : 'items-end'} gap-1`}>
                    {/* Header: Sender Phone number (only visible in All Conversations view) */}
                    {selectedSender === 'all' && (
                      <span className="text-[10px] text-zinc-500 font-medium px-1">
                        {isIncoming ? msg.sender : `Bot to ${msg.sender}`}
                      </span>
                    )}

                    {/* Chat Bubble */}
                    <div 
                      className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                        isIncoming 
                          ? 'bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-tl-none' 
                          : 'bg-blue-600 text-white rounded-tr-none'
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                    </div>

                    {/* Footer: timestamp */}
                    <span className="text-[10px] text-zinc-600 px-1">
                      {formatTime(msg.created_at)}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </main>
    </div>
  );
}
