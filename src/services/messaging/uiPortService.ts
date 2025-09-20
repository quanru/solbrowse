// Ensure logger is initialised before any logs
import '@src/utils/logger';
import browser from 'webextension-polyfill';
import { 
  UiPortMsg, 
  UiGetContentMsg,
  UiContentResponseMsg,
  UiUserPromptMsg,
  UiListTabsMsg,
  UiTabsResponseMsg,
  UiLlmDeltaMsg,
  UiLlmDoneMsg,
  UiLlmErrorMsg,
  PORT_NAMES 
} from '@src/types/messaging';

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

export interface PageContent {
  tabId: number;
  url: string;
  title: string;
  content: string;
  lastUpdated: number;
}

export interface StreamingCallbacks {
  onDelta?: (chunk: string) => void;
  onComplete?: (fullResponse: string) => void;
  onError?: (error: string) => void;
}

export class UiPortService {
  private static instance: UiPortService;
  private port: browser.Runtime.Port | null = null;
  private isConnected = false;
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    type: string;
  }>();
  private streamingCallbacks = new Map<string, StreamingCallbacks>();

  private constructor() {
    this.connect();
  }

  static getInstance(): UiPortService {
    if (!this.instance) {
      this.instance = new UiPortService();
    }
    return this.instance;
  }

  private connect(): void {
    try {
      
      // Check if extension context is valid
      if (!browser.runtime?.id) {
        throw new Error('Extension context is invalid - browser.runtime.id is undefined');
      }
      
      this.port = browser.runtime.connect({ name: PORT_NAMES.UI_PORT });
      this.setupPortHandlers();
      this.isConnected = true;
      
      // Test the connection with a ping
      this.testConnection();
    } catch (error) {
      console.error('UiPortService: Connection failed:', error);
      this.isConnected = false;
      
      // Schedule retry
      setTimeout(() => {
        this.connect();
      }, 2000);
    }
  }

  private setupPortHandlers(): void {
    if (!this.port) return;

    this.port.onMessage.addListener((message: unknown) => {
      const typedMessage = message as UiPortMsg;
      if (!typedMessage || typeof typedMessage !== 'object' || !typedMessage.type) {
        return;
      }

      this.handleMessage(typedMessage);
    });

    this.port.onDisconnect.addListener(() => {
      const error = browser.runtime.lastError;
      
      this.isConnected = false;
      this.rejectAllPendingRequests(new Error(`Port disconnected: ${error?.message || 'Unknown reason'}`));
      
      // Attempt to reconnect after a delay
      setTimeout(() => {
        if (!this.isConnected) {
          this.connect();
        }
      }, 1000);
    });
  }

  private testConnection(): void {
    // Test connection by requesting tab list
    this.listTabs()
      .then(() => {
      })
      .catch((error) => {
        this.isConnected = false;
      });
  }

  private handleMessage(message: UiPortMsg): void {

    switch (message.type) {
      case 'CONTENT_RESPONSE':
        this.handleContentResponse(message);
        break;
      case 'TABS_RESPONSE':
        this.handleTabsResponse(message);
        break;
      case 'LLM_DELTA':
        this.handleLlmDelta(message);
        break;
      case 'LLM_DONE':
        this.handleLlmDone(message);
        break;
      case 'LLM_ERROR':
        this.handleLlmError(message);
        break;
      default:
    }
  }

  private handleContentResponse(message: UiContentResponseMsg): void {
    const request = this.pendingRequests.get(message.requestId);
    if (request && request.type === 'GET_CONTENT') {
      request.resolve(message.pages);
      this.pendingRequests.delete(message.requestId);
    }
  }

  private handleTabsResponse(message: UiTabsResponseMsg): void {
    const request = this.pendingRequests.get(message.requestId);
    if (request && request.type === 'LIST_TABS') {
      request.resolve(message.tabs);
      this.pendingRequests.delete(message.requestId);
    }
  }


  private handleLlmDelta(message: UiLlmDeltaMsg): void {
    const callbacks = this.streamingCallbacks.get(message.requestId);
    if (callbacks?.onDelta) {
      callbacks.onDelta(message.delta);
    }
  }

  private handleLlmDone(message: UiLlmDoneMsg): void {
    const callbacks = this.streamingCallbacks.get(message.requestId);
    if (callbacks?.onComplete) {
      callbacks.onComplete(message.fullResponse);
    }
    this.streamingCallbacks.delete(message.requestId);
  }

  private handleLlmError(message: UiLlmErrorMsg): void {
    const callbacks = this.streamingCallbacks.get(message.requestId);
    if (callbacks?.onError) {
      callbacks.onError(message.error);
    }
    
    // Also reject any pending request
    const request = this.pendingRequests.get(message.requestId);
    if (request) {
      request.reject(new Error(message.error));
      this.pendingRequests.delete(message.requestId);
    }
    
    this.streamingCallbacks.delete(message.requestId);
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  private sendMessage(message: UiPortMsg): void {
    if (!this.port || !this.isConnected) {
      const error = new Error('Not connected to background script');
      console.error('UiPortService:', error.message);
      throw error;
    }

    try {
      this.port.postMessage(message);
    } catch (error) {
      console.error('UiPortService: Failed to send message:', error);
      this.isConnected = false;
      throw new Error(`Failed to send message to background script: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private rejectAllPendingRequests(error: Error): void {
    this.pendingRequests.forEach(request => {
      request.reject(error);
    });
    this.pendingRequests.clear();
    
    // Also notify streaming callbacks of the error
    this.streamingCallbacks.forEach(callbacks => {
      if (callbacks.onError) {
        callbacks.onError(error.message);
      }
    });
    this.streamingCallbacks.clear();
  }


  /**
   * Get available tabs
   */
  async listTabs(): Promise<TabInfo[]> {
    if (!this.isConnected || !this.port) {
      throw new Error('Not connected to background script');
    }

    const requestId = this.generateRequestId();
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Tab list request timed out'));
      }, 5000);

      this.pendingRequests.set(requestId, {
        resolve: (tabs: TabInfo[]) => {
          clearTimeout(timeout);
          // Ensure we always return an array
          resolve(Array.isArray(tabs) ? tabs : []);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
        type: 'LIST_TABS'
      });

      const message: UiListTabsMsg = {
        type: 'LIST_TABS',
        requestId
      };

      try {
        this.sendMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  /**
   * Get content from specific tabs
   */
  async getContent(tabIds: number[]): Promise<PageContent[]> {
    const requestId = this.generateRequestId();
    
    const message: UiGetContentMsg = {
      type: 'GET_CONTENT',
      tabIds,
      requestId
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject, type: 'GET_CONTENT' });
      
      try {
        this.sendMessage(message);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  /**
   * Send a user prompt and stream the response
   */
  async askQuestion(
    prompt: string, 
    tabIds: number[], 
    conversationId: string,
    callbacks: StreamingCallbacks,
    conversationHistory?: Array<{
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
    }>
  ): Promise<void> {
    if (!this.isConnected || !this.port) {
      throw new Error('Not connected to background script');
    }

    const requestId = this.generateRequestId();
    this.streamingCallbacks.set(requestId, callbacks);

    const message: UiUserPromptMsg = {
      type: 'USER_PROMPT',
      requestId,
      prompt,
      tabIds,
      conversationId,
      conversationHistory
    };

    this.sendMessage(message);
  }

  /**
   * Check if the service is connected
   */
  isConnectionHealthy(): boolean {
    return this.isConnected && this.port !== null;
  }

  /**
   * Manually reconnect
   */
  reconnect(): void {
    if (this.port) {
      this.port.disconnect();
    }
    this.connect();
  }

  /**
   * Cleanup
   */
  disconnect(): void {
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
    this.isConnected = false;
    this.rejectAllPendingRequests(new Error('Service disconnected'));
  }
} 