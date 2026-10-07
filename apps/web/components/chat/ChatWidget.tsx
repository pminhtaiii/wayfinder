'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  BookingActionCard,
  parseActionRequiredEvent,
  type SafeActionRequiredEvent,
} from './BookingActionCard';
import { CheckoutHandoffCard } from './CheckoutHandoffCard';
import { createChatStreamRequest } from '@/lib/chatStream';
import { actionHandoffSchema, type HandoffEvent } from '@shared/types/chat.types';
import { Minus } from 'lucide-react';

const OFFER_ID_PATTERN = /^off_[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function getSafeOfferId(candidate: string | null): string | null {
  return candidate && OFFER_ID_PATTERN.test(candidate) ? candidate : null;
}

function getSafeSessionId(candidate: string | null): string | null {
  return candidate && SESSION_ID_PATTERN.test(candidate) ? candidate : null;
}

function consumeSseBlock(
  block: string,
  onActionRequired: (payload: unknown) => void,
  onDone?: (sessionId: string) => void,
  onHandoff?: (payload: unknown) => void,
): void {
  const lines = block.split(/\r?\n/);
  const eventName = lines
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim();
  const data = lines
    .find((line) => line.startsWith('data:'))
    ?.slice('data:'.length)
    .trim();

  if (eventName === 'ACTION_REQUIRED' && data) {
    try {
      onActionRequired(JSON.parse(data));
    } catch {
      // A malformed event is deliberately discarded without logging its content.
    }
  } else if (eventName === 'ACTION_HANDOFF' && data && onHandoff) {
    try {
      onHandoff(JSON.parse(data));
    } catch {
      // Discard malformed event
    }
  } else if (eventName === 'done' && data) {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed.sessionId === 'string') {
        const safeSessionId = getSafeSessionId(parsed.sessionId);
        if (safeSessionId && onDone) {
          onDone(safeSessionId);
        }
      }
    } catch {
      // Discard malformed event
    }
  }
}

type ConsumeChatStreamOptions = {
  message: string;
  sessionId: string;
  token: string | null;
  signal: AbortSignal;
  onActionRequired: (payload: unknown) => void;
  onDone?: (sessionId: string) => void;
  onHandoff?: (payload: unknown) => void;
  onError?: (errorMessage: string) => void;
};

async function consumeChatStream(options: ConsumeChatStreamOptions): Promise<void> {
  const { message, sessionId, token, signal, onActionRequired, onDone, onHandoff, onError } =
    options;
  try {
    const response = await createChatStreamRequest({
      message,
      sessionId,
      token,
      signal,
    });

    if (!response.ok || !response.body) {
      onError?.('Chat service is temporarily unavailable. Please try again later.');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      blocks.forEach((block) => consumeSseBlock(block, onActionRequired, onDone, onHandoff));

      if (done) {
        if (buffer) {
          consumeSseBlock(buffer, onActionRequired, onDone, onHandoff);
        }
        return;
      }
    }
  } catch (err: unknown) {
    if (signal.aborted) {
      return;
    }
    const messageText =
      err instanceof Error && err.message
        ? err.message
        : 'Chat service is temporarily unavailable. Please try again later.';
    onError?.(messageText);
    return;
  }
}

function ChatWidgetInner(): JSX.Element {
  const { data: session } = useSession();
  const token = (session as { accessToken?: string })?.accessToken ?? null;
  const [actionEvent, setActionEvent] = useState<SafeActionRequiredEvent | null>(null);
  const [handoffEvent, setHandoffEvent] = useState<HandoffEvent | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputMessage, setInputMessage] = useState('');
  const [isMinimized, setIsMinimized] = useState(false);
  const restoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const shouldFocusRestoreRef = useRef(false);

  useEffect(() => {
    if (isMinimized && shouldFocusRestoreRef.current) {
      shouldFocusRestoreRef.current = false;
      restoreButtonRef.current?.focus();
    }
  }, [isMinimized]);

  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const offerId = getSafeOfferId(searchParams.get('offerId'));
  const sessionIdFromUrl = getSafeSessionId(searchParams.get('sessionId'));
  const autoResume = searchParams.get('autoResume') === 'true';

  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionIdFromUrl);
  const autoResumedRef = useRef(false);

  useEffect(() => {
    if (sessionIdFromUrl) {
      setActiveSessionId(sessionIdFromUrl);
    }
  }, [sessionIdFromUrl]);

  const acceptActionRequiredEvent = useCallback((payload: unknown): void => {
    const safeEvent = parseActionRequiredEvent(payload);
    if (safeEvent) {
      setActionEvent(safeEvent);
      setHandoffEvent(null);
    }
  }, []);

  const acceptHandoffEvent = useCallback((payload: unknown): void => {
    const result = actionHandoffSchema.safeParse(payload);
    if (result.success) {
      setHandoffEvent(result.data);
      setActionEvent(null);
    }
  }, []);

  const handleDone = useCallback((doneSessionId: string): void => {
    setActiveSessionId(doneSessionId);
  }, []);

  // Auto-resume hook
  useEffect(() => {
    if (autoResume && activeSessionId && token && !autoResumedRef.current) {
      autoResumedRef.current = true;
      const controller = new AbortController();
      void consumeChatStream({
        message: 'resume',
        sessionId: activeSessionId,
        token,
        signal: controller.signal,
        onActionRequired: acceptActionRequiredEvent,
        onDone: handleDone,
        onHandoff: acceptHandoffEvent,
        onError: setErrorMessage,
      });
      return () => {
        controller.abort();
        autoResumedRef.current = false;
      };
    }
  }, [
    autoResume,
    activeSessionId,
    token,
    acceptActionRequiredEvent,
    handleDone,
    acceptHandoffEvent,
  ]);

  const handleNavigate = (target: SafeActionRequiredEvent['target']): void => {
    const params = new URLSearchParams();
    const targetOfferId = actionEvent?.offerId || offerId;
    if (targetOfferId) params.set('offerId', targetOfferId);
    if (activeSessionId) params.set('sessionId', activeSessionId);
    params.set('autoResume', 'true');

    const qs = params.toString();
    const returnTo = `${pathname ?? '/'}${qs ? `?${qs}` : ''}`;

    if (target === '/checkout/passengers') {
      if (!targetOfferId) {
        return;
      }
      router.push(
        `/checkout/passengers?offerId=${encodeURIComponent(targetOfferId)}&returnTo=${encodeURIComponent(returnTo)}`,
      );
      return;
    }

    router.push(`/profile?returnTo=${encodeURIComponent(returnTo)}`);
  };

  const handleSend = () => {
    if (!inputMessage.trim()) return;
    setErrorMessage(null);
    const controller = new AbortController();
    void consumeChatStream({
      message: inputMessage,
      sessionId: activeSessionId ?? '',
      token,
      signal: controller.signal,
      onActionRequired: acceptActionRequiredEvent,
      onDone: handleDone,
      onHandoff: acceptHandoffEvent,
      onError: setErrorMessage,
    });
    setInputMessage('');
  };

  const handleMinimize = (): void => {
    shouldFocusRestoreRef.current = true;
    setIsMinimized(true);
  };

  if (isMinimized) {
    return (
      <aside className="fixed bottom-4 right-4 z-50" aria-label="Agent chat">
        <button
          ref={restoreButtonRef}
          type="button"
          onClick={() => setIsMinimized(false)}
          className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg transition-transform hover:opacity-90 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-label="Expand agent chat"
        >
          <span aria-hidden="true">💬</span>
          <span>Agent Chat</span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="card fixed bottom-4 right-4 flex h-96 w-80 flex-col overflow-hidden shadow-xl z-50"
      aria-label="Agent chat"
    >
      <div className="bg-accent p-3 font-medium text-primary-foreground flex items-center justify-between">
        <span>Agent Chat</span>
        <button
          type="button"
          onClick={handleMinimize}
          className="rounded p-1 text-primary-foreground/80 hover:bg-white/20 hover:text-primary-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-label="Minimize agent chat"
        >
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
        <p className="rounded border border-card-border bg-card p-2 text-sm text-text-primary">
          Hello! How can I help you book your flight today?
        </p>
        {errorMessage ? (
          <p
            className="rounded border border-danger-border bg-bg-cancelled p-2 text-xs text-text-cancelled"
            role="alert"
          >
            {errorMessage}
          </p>
        ) : null}
        {actionEvent ? <BookingActionCard event={actionEvent} onNavigate={handleNavigate} /> : null}
        {handoffEvent ? <CheckoutHandoffCard event={handoffEvent} /> : null}
      </div>
      <div className="border-t border-card-border bg-card p-3">
        <input
          type="text"
          placeholder="Type a message..."
          className="form-input w-full text-sm"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend();
          }}
        />
      </div>
    </aside>
  );
}

export function ChatWidget(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <ChatWidgetInner />
    </Suspense>
  );
}
