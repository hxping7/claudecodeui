import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QueuedMessage } from '../../hooks/useMessageQueue';

type MessageQueuePanelProps = {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
};

const MAX_VISIBLE_ITEMS = 10;

export default function MessageQueuePanel({ queue, onRemove, onReorder }: MessageQueuePanelProps) {
  const { t } = useTranslation('chat');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragCounterRef = useRef(0);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    dragCounterRef.current++;
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setDragOverIndex(null);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    if (dragIndex !== null && dragIndex !== toIndex) {
      onReorder(dragIndex, toIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, onReorder]);

  const handleDragEnd = useCallback(() => {
    dragCounterRef.current = 0;
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  if (queue.length === 0) return null;

  return (
    <div className="absolute top-3 right-3 z-20 w-72 pointer-events-auto">
      <div className="flex flex-col rounded-lg border border-amber-300/60 bg-amber-50/95 shadow-lg backdrop-blur-sm dark:border-amber-600/40 dark:bg-amber-900/80 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-amber-200/60 px-3 py-1.5 dark:border-amber-700/40">
          <div className="flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">
              {t('queue.title', { defaultValue: 'Queue' })} ({queue.length})
            </span>
          </div>
        </div>

        {/* Scrollable list */}
        <div
          className="overflow-y-auto overflow-x-hidden"
          style={{ maxHeight: `${MAX_VISIBLE_ITEMS * 36}px`, scrollbarGutter: 'stable' }}
        >
          {queue.map((msg, index) => (
            <div
              key={msg.id}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragEnter={(e) => handleDragEnter(e, index)}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              className={`
                group flex items-center gap-1.5 border-b border-amber-200/40 px-2 py-1.5 text-xs
                cursor-grab select-none transition-colors
                last:border-b-0
                ${dragIndex === index ? 'opacity-40' : ''}
                ${dragOverIndex === index && dragIndex !== index ? 'border-t-2 border-t-amber-500' : ''}
                hover:bg-amber-100/60 dark:hover:bg-amber-800/30
                dark:border-amber-700/30
              `}
            >
              {/* Drag handle */}
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 shrink-0 text-amber-400 dark:text-amber-500" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
              </svg>

              {/* Sequence number */}
              <span className="shrink-0 text-[10px] font-mono text-amber-500 dark:text-amber-400">
                {index + 1}.
              </span>

              {/* Content */}
              <span className="flex-1 truncate text-amber-800 dark:text-amber-200" title={msg.content}>
                {msg.content}
              </span>

              {/* Remove button */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove(msg.id); }}
                className="shrink-0 rounded p-0.5 text-amber-400 opacity-0 transition-all hover:bg-amber-200 hover:text-amber-700 group-hover:opacity-100 dark:text-amber-500 dark:hover:bg-amber-800 dark:hover:text-amber-100"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
