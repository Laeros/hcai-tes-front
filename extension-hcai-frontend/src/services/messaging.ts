/** Envoltorio de chrome.runtime.sendMessage para content script y componentes React. */
import type { ExtensionRequest, ResponseFor } from '../types/messages';

export class ExtensionContextError extends Error {
  constructor() {
    super('El contexto de la extensión ya no es válido (extensión recargada o actualizada).');
    this.name = 'ExtensionContextError';
  }
}

type InvalidatedHandler = () => void;
const invalidatedHandlers = new Set<InvalidatedHandler>();

export function isExtensionAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string';
  } catch {
    return false;
  }
}

/** Registra un callback que se ejecuta una sola vez cuando el contexto queda huérfano. */
export function onContextInvalidated(handler: InvalidatedHandler): () => void {
  invalidatedHandlers.add(handler);
  return () => invalidatedHandlers.delete(handler);
}

function fireInvalidated(): void {
  const handlers = Array.from(invalidatedHandlers);
  invalidatedHandlers.clear();
  handlers.forEach((handler) => handler());
}

export async function sendRequest<T extends ExtensionRequest>(request: T): Promise<ResponseFor<T['type']>> {
  if (!isExtensionAlive()) {
    fireInvalidated();
    throw new ExtensionContextError();
  }
  try {
    return (await chrome.runtime.sendMessage(request)) as ResponseFor<T['type']>;
  } catch (error) {
    if (!isExtensionAlive() || (error instanceof Error && /context invalidated/i.test(error.message))) {
      fireInvalidated();
      throw new ExtensionContextError();
    }
    throw error;
  }
}
