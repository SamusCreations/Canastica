import React, { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, Send, Sparkles, User, X } from 'lucide-react';
import { answerHouseholdQuestion } from '../services/geminiAndSupabaseService';
import {
  Household,
  PantryItem,
  Purchase,
  RestockPrediction,
  ShoppingListItem,
} from '../types/grocery';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

interface AIAssistantDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  initialPrompt?: string | null;
  onClearInitialPrompt: () => void;
  household: Household;
  purchases: Purchase[];
  shoppingList: ShoppingListItem[];
  pantry: PantryItem[];
  predictions: RestockPrediction[];
}

const SUGGESTED_QUESTIONS = [
  '¿Cuánto gastamos en carne en septiembre?',
  '¿Cuál fue la compra más cara del año?',
  '¿En qué supermercado sale más barato el pollo y la leche?',
  '¿Qué productos están por agotarse o vencer pronto?',
];

export const AIAssistantDrawer: React.FC<AIAssistantDrawerProps> = ({
  isOpen,
  onClose,
  initialPrompt,
  onClearInitialPrompt,
  household,
  purchases,
  shoppingList,
  pantry,
  predictions,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'msg-welcome',
      role: 'assistant',
      text: `¡Hola! Soy el **Asistente** de **${household.name}**. Pregúntame en lenguaje natural sobre tus facturas, gastos por categoría en colones (₡), comparador de supermercados o predicciones de reposición.`,
      timestamp: 'Ahora',
    },
  ]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const sendQuestion = async (questionText: string) => {
    const trimmed = questionText.trim();
    if (!trimmed) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: trimmed,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsThinking(true);

    try {
      await new Promise((r) => setTimeout(r, 350));
      const reply = await answerHouseholdQuestion(trimmed, {
        household,
        purchases,
        shoppingList,
        pantry,
        predictions,
      });

      setMessages((prev) => [
        ...prev,
        {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          text: reply,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsThinking(false);
    }
  };

  useEffect(() => {
    if (isOpen && initialPrompt) {
      sendQuestion(initialPrompt);
      onClearInitialPrompt();
    }
  }, [isOpen, initialPrompt]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  if (!isOpen) return null;

  const renderFormattedText = (raw: string) => {
    return raw.split('\n').map((line, i) => {
      const parts = line.split(/(\*\*.*?\*\*)/g);
      return (
        <p key={i} className="leading-relaxed min-h-[1rem]">
          {parts.map((part, idx) =>
            part.startsWith('**') && part.endsWith('**') ? (
              <strong key={idx} className="text-avocado-600 dark:text-avocado-400 font-bold">
                {part.slice(2, -2)}
              </strong>
            ) : (
              <span key={idx}>{part}</span>
            )
          )}
        </p>
      );
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-sm animate-spring-in">
      <div className="liquid-glass-elevated w-full max-w-lg h-full flex flex-col justify-between overflow-hidden border-l border-[var(--glass-border)]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--glass-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl liquid-lens-btn flex items-center justify-center text-white">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold flex items-center gap-1.5">
                Asistente Conversacional del Hogar
                <Sparkles className="w-3.5 h-3.5 text-avocado-600 dark:text-avocado-400" />
              </h3>
              <p className="text-[11px] text-[var(--text-muted)]">
                Responde con los datos de tus facturas y despensa
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl liquid-glass liquid-glass-interactive"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Messages Feed */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex items-start gap-2.5 ${
                msg.role === 'user' ? 'flex-row-reverse' : ''
              }`}
            >
              <div
                className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                  msg.role === 'assistant'
                    ? 'liquid-lens-btn text-white'
                    : 'liquid-glass-subtle text-avocado-600 dark:text-avocado-400'
                }`}
              >
                {msg.role === 'assistant' ? (
                  <Sparkles className="w-4 h-4" />
                ) : (
                  <User className="w-4 h-4" />
                )}
              </div>

              <div
                className={`max-w-[84%] rounded-2xl p-3.5 text-xs space-y-1 ${
                  msg.role === 'assistant'
                    ? 'liquid-glass-subtle'
                    : 'bg-avocado-600 text-white'
                }`}
              >
                {msg.role === 'assistant' ? (
                  renderFormattedText(msg.text)
                ) : (
                  <p className="leading-relaxed">{msg.text}</p>
                )}
                <span className="text-[10px] opacity-60 block pt-1 text-right">
                  {msg.timestamp}
                </span>
              </div>
            </div>
          ))}

          {isThinking && (
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg liquid-lens-btn flex items-center justify-center text-white">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
              <div className="liquid-skeleton h-11 w-56 rounded-xl" />
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Suggested Quick Questions + Input */}
        <div className="p-4 border-t border-[var(--glass-border)] space-y-3 bg-[var(--glass-bg-subtle)]">
          <div className="flex flex-wrap items-center gap-1.5">
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => sendQuestion(q)}
                className="text-[11px] px-2.5 py-1 rounded-lg liquid-glass liquid-glass-interactive text-avocado-600 dark:text-avocado-400 font-medium"
              >
                {q}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendQuestion(input);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='Pregunta ej.: "¿Cuánto gastamos en carne en septiembre?"...'
              className="liquid-input flex-1 px-4 py-2.5 rounded-xl text-xs"
            />
            <button
              type="submit"
              disabled={!input.trim() || isThinking}
              className="liquid-lens-btn px-4 py-2.5 rounded-xl text-white disabled:opacity-40 flex items-center justify-center"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
