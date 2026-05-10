import { useState, useCallback, useRef, useEffect } from 'react';

export type QueuedMessage = {
  id: string;
  content: string;
  images: unknown[];
  timestamp: number;
  provider: string;
  model: string;
};

export type MessageQueueOptions = {
  onProcessQueue?: (messages: QueuedMessage[]) => void;
};

export function useMessageQueue(options: MessageQueueOptions = {}) {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const processingRef = useRef(false);

  const addToQueue = useCallback((
    content: string,
    options: {
      images?: unknown[];
      provider: string;
      model: string;
    }
  ) => {
    const message: QueuedMessage = {
      id: `queued-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      content,
      images: options.images || [],
      timestamp: Date.now(),
      provider: options.provider,
      model: options.model,
    };
    setQueue((prev) => [...prev, message]);
    return message.id;
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);

  const removeFromQueue = useCallback((id: string) => {
    setQueue((prev) => prev.filter((msg) => msg.id !== id));
  }, []);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue((prev) => {
      if (fromIndex < 0 || fromIndex >= prev.length || toIndex < 0 || toIndex >= prev.length) {
        return prev;
      }
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      return updated;
    });
  }, []);

  const processNextMessage = useCallback(() => {
    if (processingRef.current || queue.length === 0) {
      return null;
    }

    const [nextMessage, ...remaining] = queue;
    processingRef.current = true;
    setIsProcessing(true);
    setQueue(remaining);

    return nextMessage;
  }, [queue]);

  const finishProcessing = useCallback(() => {
    processingRef.current = false;
    setIsProcessing(false);
  }, []);

  const peekNext = useCallback(() => {
    return queue.length > 0 ? queue[0] : null;
  }, [queue]);

  return {
    queue,
    queueLength: queue.length,
    isProcessing,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    clearQueue,
    processNextMessage,
    finishProcessing,
    peekNext,
  };
}

export default useMessageQueue;
