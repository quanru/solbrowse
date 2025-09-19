import browser from 'webextension-polyfill';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface Message {
  type: 'user' | 'assistant';
  content: string;
  timestamp: number;
  tabIds?: number[];
}

export interface Conversation {
  id: string;
  url: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationAction {
  type: 'ADD_USER_MESSAGE' | 'ADD_ASSISTANT_MESSAGE' | 'CLEAR_CONVERSATION' | 'UPDATE_CONVERSATION_ID' | 'SET_CONVERSATION' | 'UPDATE_STREAMING_MESSAGE';
  payload: any;
}

export interface ConversationState {
  activeConversationId: string | null;
  messages: Message[];
  conversations: Conversation[];
}

export interface TabConversation {
  messages: Message[];
  conversationId: string | null;
  tabId: string;
  url: string;
  host: string;
}

export type ConversationListener = (state: ConversationState) => void;
export type TabConversationListener = (state: TabConversation) => void;

export type ConversationContext = 'global' | 'tab';

// ============================================================================
// UNIFIED CONVERSATION SERVICE
// ============================================================================

export class conversation {
  private static instance: conversation;
  
  // Global conversation state
  private globalState: ConversationState = {
    activeConversationId: null,
    messages: [],
    conversations: []
  };
  
  // Tab conversation states (keyed by tab ID)
  private tabStates: Map<string, TabConversation> = new Map();
  
  // Listeners
  private globalListeners: ConversationListener[] = [];
  private tabListeners: Map<string, TabConversationListener[]> = new Map();
  
  // Navigation handlers for tab contexts
  private navigationHandlers: Map<string, (() => void)[]> = new Map();

  private constructor() {
    this.initializeStorage();
    this.setupNavigationListeners();
  }

  static getInstance(): conversation {
    if (!this.instance) {
      this.instance = new conversation();
    }
    return this.instance;
  }

  // ============================================================================
  // UNIFIED STORAGE OPERATIONS
  // ============================================================================

  async getConversations(): Promise<Conversation[]> {
    try {
      const response = await browser.runtime.sendMessage({
        type: 'GET_ALL_CONVERSATIONS'
      });
      
      return Array.isArray(response?.conversations) ? response.conversations : [];
    } catch (error) {
      console.error('Sol Conversation: Failed to get conversations:', error);
      return [];
    }
  }

  async getConversation(id: string): Promise<Conversation | null> {
    try {
      const response = await browser.runtime.sendMessage({
        type: 'GET_CONVERSATION',
        id: id
      });
      
      return response?.conversation || null;
    } catch (error) {
      console.error('Sol Conversation: Failed to get conversation:', error);
      return null;
    }
  }

  async saveConversation(conversation: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    try {
      const now = Date.now();
      const id = `conv_${now}_${Math.random().toString(36).substr(2, 9)}`;
      
      const fullConversation: Conversation = {
        id,
        title: conversation.title,
        url: conversation.url,
        messages: conversation.messages,
        createdAt: now,
        updatedAt: now
      };

      await this.saveToUnifiedStorage(fullConversation);
      
      return id;
    } catch (error) {
      console.error('Sol Conversation: Failed to save conversation:', error);
      throw error;
    }
  }

  async updateConversation(id: string, updates: Partial<Pick<Conversation, 'messages' | 'title'>>): Promise<void> {
    try {
      const response = await browser.runtime.sendMessage({
        type: 'UPDATE_CONVERSATION',
        id: id,
        updates: updates
      });

      if (!response?.success) {
        throw new Error('Failed to update conversation in unified storage');
      }
    } catch (error) {
      console.error(`Sol Conversation: Failed to update conversation ${id}:`, error);
      throw error;
    }
  }

  async deleteConversation(id: string): Promise<void> {
    try {
      const response = await browser.runtime.sendMessage({
        type: 'DELETE_CONVERSATION',
        id: id
      });

      if (!response?.success) {
        throw new Error('Failed to delete conversation from unified storage');
      }
    } catch (error) {
      console.error('Sol Conversation: Failed to delete conversation:', error);
      throw error;
    }
  }

  async deleteAllConversations(): Promise<void> {
    try {
      const response = await browser.runtime.sendMessage({
        type: 'DELETE_ALL_CONVERSATIONS'
      });

      if (!response?.success) {
        throw new Error('Failed to delete all conversations from unified storage');
      }
    } catch (error) {
      console.error('Sol Conversation: Failed to delete all conversations:', error);
      throw error;
    }
  }

  // ============================================================================
  // UNIFIED STORAGE HELPERS
  // ============================================================================

  // Load conversations from unified background storage
  private async loadFromUnifiedStorage(): Promise<Conversation[]> {
    try {
      // Request conversations from background unified storage
      const response = await browser.runtime.sendMessage({
        type: 'GET_ALL_CONVERSATIONS'
      });
      
      return Array.isArray(response?.conversations) ? response.conversations : [];
    } catch (error) {
      console.error('Sol conversation: Failed to load from unified storage:', error);
      return [];
    }
  }

  // Save conversation to unified background storage
  private async saveToUnifiedStorage(conversation: Conversation): Promise<void> {
    await browser.runtime.sendMessage({
      type: 'SAVE_CONVERSATION',
      conversation
    });
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  private async initializeStorage(): Promise<void> {
    try {
      await this.loadGlobalConversations();
      console.log('Sol conversation: Storage initialized');
    } catch (error) {
      console.error('Sol conversation: Storage initialization failed:', error);
    }
  }

  private setupNavigationListeners(): void {
    // This will be called from tab contexts to set up navigation detection
    if (typeof window !== 'undefined') {
      const handleNavigation = () => {
        const newUrl = window.location.href;
        const newHost = window.location.hostname;
        
        // Clear all tab conversations on navigation
        this.tabStates.forEach((state, tabId) => {
          if (state.url !== newUrl || state.host !== newHost) {
            this.clearTabConversation(tabId);
            
            // Notify navigation handlers
            const handlers = this.navigationHandlers.get(tabId) || [];
            handlers.forEach(handler => {
              try {
                handler();
              } catch (error) {
                console.error('Sol conversation: Error in navigation handler:', error);
              }
            });
          }
        });
      };

      // Listen for navigation changes
      window.addEventListener('popstate', handleNavigation);
      
      // Override pushState and replaceState to catch programmatic navigation
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      
      history.pushState = function(...args) {
        originalPushState.apply(history, args);
        setTimeout(handleNavigation, 0);
      };
      
      history.replaceState = function(...args) {
        originalReplaceState.apply(history, args);
        setTimeout(handleNavigation, 0);
      };
    }
  }

  // ============================================================================
  // GLOBAL CONVERSATION MANAGEMENT
  // ============================================================================

  async loadGlobalConversations(): Promise<void> {
    try {
      // Load from unified background storage only
      const conversations = await this.loadFromUnifiedStorage();
      this.globalState.conversations = conversations;
      this.notifyGlobalListeners();
    } catch (error) {
      console.error('Sol conversation: Failed to load global conversations:', error);
      this.globalState.conversations = [];
      this.notifyGlobalListeners();
    }
  }

  private async loadActiveGlobalConversationMessages(): Promise<void> {
    if (!this.globalState.activeConversationId) return;

    try {
      const conversation = await this.getConversation(this.globalState.activeConversationId);
      this.globalState.messages = conversation?.messages || [];
      this.notifyGlobalListeners();
    } catch (error) {
      console.error('Sol conversation: Failed to load active conversation messages:', error);
    }
  }

  async createNewGlobalConversation(): Promise<string> {
    try {
      const currentTab = browser.tabs ? (await browser.tabs.query({ active: true, currentWindow: true }))[0] : null;
      const newConversation = {
        title: 'New Conversation',
        url: currentTab?.url || '',
        messages: []
      };

      const conversationId = await this.saveConversation(newConversation);
      
      // Update global state
      this.globalState.activeConversationId = conversationId;
      this.globalState.messages = [];
      
      // Reload conversations to get the new one
      await this.loadGlobalConversations();
      
      // Ensure activeConversationId is preserved after loadGlobalConversations
      this.globalState.activeConversationId = conversationId;
      
      // Notify listeners with the correct state
      this.notifyGlobalListeners();
      return conversationId;
    } catch (error) {
      console.error('Sol Conversation: Failed to create new global conversation:', error);
      throw error;
    }
  }

  async switchToGlobalConversation(conversationId: string): Promise<void> {
    try {
      const conversation = await this.getConversation(conversationId);
      if (!conversation) {
        throw new Error(`Conversation ${conversationId} not found`);
      }

      this.globalState.activeConversationId = conversationId;
      this.globalState.messages = conversation.messages;
      this.notifyGlobalListeners();
    } catch (error) {
      console.error('Sol conversation: Failed to switch global conversation:', error);
      throw error;
    }
  }

  async globalDispatch(action: ConversationAction): Promise<void> {
    try {
      const newMessages = this.reduceAction(this.globalState.messages, action);
      this.globalState.messages = newMessages;

      // Update storage if we have an active conversation
      if (this.globalState.activeConversationId) {
        await this.updateConversation(this.globalState.activeConversationId, { 
          messages: newMessages 
        });
      }

      this.notifyGlobalListeners();
    } catch (error) {
      console.error('Sol Conversation: Failed to dispatch global action:', error);
      throw error;
    }
  }

  // ============================================================================
  // TAB CONVERSATION MANAGEMENT
  // ============================================================================

  getTabConversation(tabId: string): TabConversation {
    if (!this.tabStates.has(tabId)) {
      // Initialize tab conversation
      this.tabStates.set(tabId, {
        messages: [],
        conversationId: null,
        tabId,
        url: typeof window !== 'undefined' ? window.location.href : '',
        host: typeof window !== 'undefined' ? window.location.hostname : ''
      });
    }
    return this.tabStates.get(tabId)!;
  }

  setTabConversation(tabId: string, messages: Message[], conversationId: string | null): void {
    const currentState = this.getTabConversation(tabId);
    const newState: TabConversation = {
      ...currentState,
      messages,
      conversationId
    };
    
    this.tabStates.set(tabId, newState);
    this.notifyTabListeners(tabId, newState);
  }

  tabDispatch(tabId: string, action: ConversationAction): void {
    const currentState = this.getTabConversation(tabId);
    const newMessages = this.reduceAction(currentState.messages, action);
    
    const newState: TabConversation = {
      ...currentState,
      messages: newMessages
    };
    
    this.tabStates.set(tabId, newState);
    this.notifyTabListeners(tabId, newState);
  }

  clearTabConversation(tabId: string): void {
    this.tabDispatch(tabId, { type: 'CLEAR_CONVERSATION', payload: null });
  }

  // ============================================================================
  // SHARED ACTION REDUCER
  // ============================================================================

  private reduceAction(messages: Message[], action: ConversationAction): Message[] {
    switch (action.type) {
      case 'ADD_USER_MESSAGE':
        return [...messages, {
          type: 'user' as const,
          content: action.payload.content,
          timestamp: Date.now(),
          tabIds: action.payload.tabIds
        }];

      case 'ADD_ASSISTANT_MESSAGE':
        return [...messages, {
          type: 'assistant' as const,
          content: action.payload.content,
          timestamp: Date.now()
        }];

      case 'UPDATE_STREAMING_MESSAGE':
        // Update the last assistant message (streaming) or create one if it doesn't exist
        const lastIndex = messages.length - 1;
        if (lastIndex >= 0 && messages[lastIndex].type === 'assistant') {
          // Update existing assistant message
          const updatedMessages = [...messages];
          updatedMessages[lastIndex] = {
            ...updatedMessages[lastIndex],
            content: action.payload.content
          };
          return updatedMessages;
        } else {
          // Create new assistant message for streaming
          return [...messages, {
            type: 'assistant' as const,
            content: action.payload.content,
            timestamp: Date.now()
          }];
        }

      case 'CLEAR_CONVERSATION':
        return [];

      case 'UPDATE_CONVERSATION_ID':
        // This doesn't affect messages, handled at the state level
        return messages;

      case 'SET_CONVERSATION':
        return action.payload.messages || [];

      default:
        return messages;
    }
  }

  // ============================================================================
  // SUBSCRIPTION MANAGEMENT
  // ============================================================================

  subscribeToGlobal(listener: ConversationListener): () => void {
    this.globalListeners.push(listener);
    
    return () => {
      const index = this.globalListeners.indexOf(listener);
      if (index > -1) {
        this.globalListeners.splice(index, 1);
      }
    };
  }

  subscribeToTab(tabId: string, listener: TabConversationListener): () => void {
    if (!this.tabListeners.has(tabId)) {
      this.tabListeners.set(tabId, []);
    }
    
    this.tabListeners.get(tabId)!.push(listener);
    
    return () => {
      const listeners = this.tabListeners.get(tabId);
      if (listeners) {
        const index = listeners.indexOf(listener);
        if (index > -1) {
          listeners.splice(index, 1);
        }
      }
    };
  }

  addTabNavigationHandler(tabId: string, handler: () => void): () => void {
    if (!this.navigationHandlers.has(tabId)) {
      this.navigationHandlers.set(tabId, []);
    }
    
    this.navigationHandlers.get(tabId)!.push(handler);
    
    return () => {
      const handlers = this.navigationHandlers.get(tabId);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index > -1) {
          handlers.splice(index, 1);
        }
      }
    };
  }

  private notifyGlobalListeners(): void {
    this.globalListeners.forEach(listener => {
      try {
        listener({ ...this.globalState });
      } catch (error) {
        console.error('Sol conversation: Error in global listener:', error);
      }
    });
  }

  private notifyTabListeners(tabId: string, state: TabConversation): void {
    const listeners = this.tabListeners.get(tabId);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(state);
        } catch (error) {
          console.error('Sol conversation: Error in tab listener:', error);
        }
      });
    }
  }

  // ============================================================================
  // PUBLIC API METHODS
  // ============================================================================

  // Global API
  getGlobalState(): ConversationState {
    return { ...this.globalState };
  }

  getGlobalActiveConversationId(): string | null {
    return this.globalState.activeConversationId;
  }

  getGlobalMessages(): Message[] {
    return [...this.globalState.messages];
  }

  getGlobalConversations(): Conversation[] {
    return [...this.globalState.conversations];
  }

  private generateConversationTitle(content: string): string {
    // Clean and truncate the content to create a meaningful title
    // First remove tab mentions like 🔗TabName🔗
    let cleaned = content.replace(/🔗[^🔗]+🔗/g, '').trim();
    
    // Then clean up extra spaces and some control characters, but keep unicode characters
    cleaned = cleaned
      .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters but keep printable unicode
      .trim();
    
    if (cleaned.length === 0) {
      return 'Untitled Conversation';
    }
    
    if (cleaned.length <= 50) {
      return cleaned;
    }
    
    // Try to break at word boundary
    const truncated = cleaned.substring(0, 47);
    const lastSpace = truncated.lastIndexOf(' ');
    
    if (lastSpace > 20) { // If we can break at a reasonable word boundary
      return truncated.substring(0, lastSpace) + '...';
    } else {
      return truncated + '...';
    }
  }

  async addGlobalUserMessage(content: string, tabIds?: number[]): Promise<void> {
    await this.globalDispatch({
      type: 'ADD_USER_MESSAGE',
      payload: { content, tabIds }
    });
    
    // Auto-generate title for new conversations from first user message
    if (this.globalState.activeConversationId && this.globalState.messages.length === 1) {
      const conversation = await this.getConversation(this.globalState.activeConversationId);
      
      if (conversation && conversation.title === 'New Conversation') {
        const newTitle = this.generateConversationTitle(content);
        await this.updateConversation(this.globalState.activeConversationId, { title: newTitle });
        await this.loadGlobalConversations(); // Refresh to show new title
        this.notifyGlobalListeners(); // Ensure UI gets updated
      }
    }
  }

  async addGlobalAssistantMessage(content: string): Promise<void> {
    await this.globalDispatch({
      type: 'ADD_ASSISTANT_MESSAGE',
      payload: { content }
    });
  }

  async updateGlobalStreamingMessage(content: string): Promise<void> {
    await this.globalDispatch({
      type: 'UPDATE_STREAMING_MESSAGE',
      payload: { content }
    });
  }

  async clearGlobalConversation(): Promise<void> {
    await this.globalDispatch({ type: 'CLEAR_CONVERSATION', payload: {} });
  }

  async deleteGlobalConversation(conversationId: string): Promise<void> {
    try {
      await this.deleteConversation(conversationId);
      
      // If we deleted the active conversation, clear the state
      if (this.globalState.activeConversationId === conversationId) {
        this.globalState.activeConversationId = null;
        this.globalState.messages = [];
      }
      
      await this.loadGlobalConversations();
      this.notifyGlobalListeners(); // Ensure UI gets updated
    } catch (error) {
      console.error('Sol conversation: Failed to delete global conversation:', error);
      throw error;
    }
  }

  async renameGlobalConversation(conversationId: string, title: string): Promise<void> {
    try {
      await this.updateConversation(conversationId, { title });
      await this.loadGlobalConversations();
      this.notifyGlobalListeners(); // Ensure UI gets updated
    } catch (error) {
      console.error('Sol conversation: Failed to rename global conversation:', error);
      throw error;
    }
  }

  // Tab API
  getTabState(tabId: string): TabConversation {
    return this.getTabConversation(tabId);
  }

  addTabUserMessage(tabId: string, content: string, tabIds?: number[]): void {
    this.tabDispatch(tabId, {
      type: 'ADD_USER_MESSAGE',
      payload: { content, tabIds }
    });
  }

  addTabAssistantMessage(tabId: string, content: string): void {
    this.tabDispatch(tabId, {
      type: 'ADD_ASSISTANT_MESSAGE',
      payload: { content }
    });
  }

  updateTabStreamingMessage(tabId: string, content: string): void {
    this.tabDispatch(tabId, {
      type: 'UPDATE_STREAMING_MESSAGE',
      payload: { content }
    });
  }

  setTabConversationId(tabId: string, conversationId: string | null): void {
    const currentState = this.getTabConversation(tabId);
    const newState: TabConversation = {
      ...currentState,
      conversationId
    };
    
    this.tabStates.set(tabId, newState);
    this.notifyTabListeners(tabId, newState);
  }

  // ============================================================================
  // CONTEXT SWITCHING API
  // ============================================================================

  async syncTabToGlobal(tabId: string): Promise<string | null> {
    const tabState = this.getTabConversation(tabId);
    
    if (tabState.messages.length === 0) {
      return null;
    }

    try {
      // Create or update global conversation
      let conversationId = tabState.conversationId;
      
      if (!conversationId) {
        // Create new global conversation
        conversationId = await this.createNewGlobalConversation();
        this.setTabConversationId(tabId, conversationId);
      }

      // Update global conversation with tab messages
      await this.updateConversation(conversationId, {
        messages: tabState.messages
      });

      // Ensure conversation has a meaningful title
      const convAfterUpdate = await this.getConversation(conversationId);
      if (convAfterUpdate && (!convAfterUpdate.title || convAfterUpdate.title === 'New Conversation')) {
        const firstUserMsg = tabState.messages.find(m => m.type === 'user') || tabState.messages[0];
        if (firstUserMsg) {
          const newTitle = this.generateConversationTitle(firstUserMsg.content);
          await this.updateConversation(conversationId, { title: newTitle });
        }
      }

      // Switch to this conversation globally
      await this.switchToGlobalConversation(conversationId);

      return conversationId;
    } catch (error) {
      console.error('Sol conversation: Failed to sync tab to global:', error);
      throw error;
    }
  }

  async syncGlobalToTab(tabId: string, conversationId?: string): Promise<void> {
    try {
      const targetId = conversationId || this.globalState.activeConversationId;
      if (!targetId) return;

      const conversation = await this.getConversation(targetId);
      if (!conversation) return;

      this.setTabConversation(tabId, conversation.messages, targetId);
    } catch (error) {
      console.error('Sol conversation: Failed to sync global to tab:', error);
      throw error;
    }
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  disconnect(): void {
    // Clear all listeners
    this.globalListeners = [];
    this.tabListeners.clear();
    this.navigationHandlers.clear();
    
    // Clear tab states
    this.tabStates.clear();
  }

  cleanupTab(tabId: string): void {
    this.tabStates.delete(tabId);
    this.tabListeners.delete(tabId);
    this.navigationHandlers.delete(tabId);
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

const conversationInstance = conversation.getInstance();

// Export debug function to global scope for console debugging
if (typeof window !== 'undefined') {
  (window as any).solReloadConversations = () => conversationInstance.loadGlobalConversations();
}

export default conversationInstance;