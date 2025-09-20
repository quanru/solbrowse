import '@src/utils/logger';
import browser from 'webextension-polyfill';
import { ApiService } from '@src/services/api';
import settingsService from '@src/utils/settings';
import { PortManager } from '@src/services/messaging/portManager';
import { TabSnapshotManager } from '@src/services/scraping/snapshotManager';
import { createSystemPrompt, createWebsiteContext } from '@src/utils/promptBuilder';
import { 
  ContentInitMsg, 
  ContentDeltaMsg, 
  UiGetContentMsg, 
  UiUserPromptMsg,
  UiListTabsMsg,
  UiContentResponseMsg,
  UiTabsResponseMsg,
  GetCurrentTabIdResponseMsg
} from '@src/types/messaging';
import storage from '@src/services/storage';


// Initialize managers
const portManager = PortManager.getInstance();
const snapshotManager = TabSnapshotManager.getInstance();

// Enable debug mode if storage flag set (supports both new `debug` flag and legacy `debugScraping` flag)
browser.storage.local.get(['debug', 'debugScraping']).then(res => {
  const enabled = !!res.debug || !!res.debugScraping;
  snapshotManager.setDebug(enabled);
});

// Listen for storage changes to toggle debug flag
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.debug) {
      snapshotManager.setDebug(!!changes.debug.newValue);
    } else if (changes.debugScraping) { // Backward compatibility
      snapshotManager.setDebug(!!changes.debugScraping.newValue);
    }
  }
});

// Check for schema updates and reset if needed
const checkAndResetSchema = async () => {
  try {
    if (await settingsService.needsSchemaReset()) {
      await settingsService.resetToDefaults();
    }
  } catch (error) {
    console.error('Background: Error during schema check:', error);
  }
};

// Keep the service worker alive
const keepAlive = () => {
  setInterval(() => {
    browser.runtime.getPlatformInfo().catch(() => {
      // Ignore errors, this is just to keep the service worker alive
    });
  }, 20000);
};


// Consolidated function to process tab snapshots into page format
const processTabSnapshots = (snapshots: Array<any>, tabIds: number[]) => {
  return snapshots.map((snapshot, index) => {
    const tabId = tabIds[index];
    if (!snapshot) {
      return {
        tabId,
        url: '',
        title: `Tab ${tabId}`,
        content: '[No content available]',
        lastUpdated: 0
      };
    }
    
    return {
      tabId: snapshot.tabId,
      url: snapshot.url,
      title: snapshot.title,
      content: snapshot.content,
      lastUpdated: snapshot.timestamp
    };
  });
};

// Simplified function to ensure content availability for tabs
const ensureTabsHaveContent = async (tabIds: number[]): Promise<void> => {
  const maxWaitTimeMs = 5000; // total time to wait
  const pollIntervalMs = 500; // how often to check

  // Helper for snapshot existence check
  const needsContent = (id: number) => {
    const snapshot = snapshotManager.getLatestSnapshot(id);
    return !snapshot || snapshot.content === '[No content available]' || Date.now() - snapshot.timestamp > 60000;
  };

  const logSnapshotState = (ids: number[]) => {
    ids.forEach(id => {
    });
  };

  let tabsWithoutContent = tabIds.filter(needsContent);
  if (tabsWithoutContent.length === 0) {
    return;
  }

  // Trigger scraping for tabs without content
  for (const tabId of tabsWithoutContent) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        continue;
      }

      await browser.scripting.executeScript({
        target: { tabId },
        func: () => {
          if ((window as any).solContentScript?.scraper?.triggerManualScrape) {
            (window as any).solContentScript.scraper.triggerManualScrape();
            console.log('Sol: Triggered manual scrape for multi-tab context');
          }
        }
      });
    } catch (error) {
    }
  }

  // Poll until all required content is available or timeout reached
  const start = Date.now();
  while (Date.now() - start < maxWaitTimeMs) {
    await new Promise(res => setTimeout(res, pollIntervalMs));
    tabsWithoutContent = tabIds.filter(needsContent);
    if (tabsWithoutContent.length === 0) {
      break;
    }
  }

};

// Setup messaging handlers
const setupMessageHandlers = () => {
  // Content script handlers
  portManager.addContentHandler<ContentInitMsg>('INIT_SCRAPE', (message, port) => {
    
    snapshotManager.addSnapshot({
      tabId: message.tabId,
      url: message.url,
      title: message.title,
      content: message.html,
      changeType: 'init'
    });
  });

  portManager.addContentHandler<ContentDeltaMsg>('DELTA_SCRAPE', (message, port) => {
    
    snapshotManager.addSnapshot({
      tabId: message.tabId,
      url: message.url,
      title: '', // Delta messages don't include title
      content: message.html,
      changeType: message.changeType
    });
  });

  // UI request handlers (these send responses)
  portManager.addRequestHandler<UiGetContentMsg, UiContentResponseMsg>('GET_CONTENT', async (message, port) => {
    
    const snapshots = snapshotManager.getLatestSnapshots(message.tabIds);
    const pages = processTabSnapshots(snapshots, message.tabIds);

    return {
      type: 'CONTENT_RESPONSE',
      requestId: message.requestId,
      pages
    };
  });

  portManager.addRequestHandler<UiListTabsMsg, UiTabsResponseMsg>('LIST_TABS', async (message, port) => {
    try {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const tabList = tabs
        .filter(tab => tab.id !== undefined)
        .map(tab => ({
          id: tab.id!,
          title: tab.title || 'Untitled',
          url: tab.url || '',
          favIconUrl: tab.favIconUrl
        }));

      return {
        type: 'TABS_RESPONSE',
        requestId: message.requestId,
        tabs: tabList
      };
    } catch (error) {
      console.error('Background: Error listing tabs:', error);
      return {
        type: 'TABS_RESPONSE',
        requestId: message.requestId,
        tabs: []
      };
    }
  });

  portManager.addUiHandler<UiUserPromptMsg>('USER_PROMPT', async (message, port) => {
    
    try {
      await ensureTabsHaveContent(message.tabIds);

      const snapshots = snapshotManager.getLatestSnapshots(message.tabIds);
      const pages = processTabSnapshots(snapshots, message.tabIds);


      const settings = await settingsService.getAll();
      
      // Separate available and unavailable content
      const availablePages = pages.filter(page => page.content && page.content !== '[No content available]');
      const unavailablePages = pages.filter(page => page.content === '[No content available]');
      
      // Create context from available pages
      const contextMessage = availablePages
        .map(page => createWebsiteContext({
          url: page.url,
          title: page.title,
          content: page.content,
          metadata: { tabId: page.tabId, lastUpdated: page.lastUpdated }
        }))
        .join('\n\n');
      
      // Create user notice for unavailable tabs
      const contextNotice = unavailablePages.length > 0 
        ? `\n\nNote: Content from ${unavailablePages.length} mentioned tab(s) (${unavailablePages.map(p => p.tabId).join(', ')}) is not available.`
        : '';
      
      // Build messages array
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: createSystemPrompt() }
      ];

      // Add tab content if available
      if (contextMessage) {
        messages.push({ role: 'system', content: contextMessage });
      }

      // Add conversation history (last 12 messages to avoid context window issues)
      if (message.conversationHistory?.length) {
        message.conversationHistory.slice(-12).forEach(historyMessage => {
          messages.push({
            role: historyMessage.role,
            content: historyMessage.content
          });
        });
      }

      // Add current user message with notice
      messages.push({ role: 'user', content: message.prompt + contextNotice });

      
      // Start streaming
      await ApiService.streamChatCompletion({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        messages,
        customEndpoint: settings.customEndpoint,
        abortSignal: new AbortController().signal,
        onDelta: (chunk: string) => {
          portManager.sendToUiPort(port, {
            type: 'LLM_DELTA',
            requestId: message.requestId,
            delta: chunk
          });
        },
        onComplete: () => {
          portManager.sendToUiPort(port, {
            type: 'LLM_DONE',
            requestId: message.requestId,
            fullResponse: ''
          });
        },
        onError: (error: Error) => {
          portManager.sendToUiPort(port, {
            type: 'LLM_ERROR',
            requestId: message.requestId,
            error: error.message
          });
        }
      });

    } catch (error) {
      console.error('Background: Error handling user prompt:', error);
      portManager.sendToUiPort(port, {
        type: 'LLM_ERROR',
        requestId: message.requestId,
        error: `Failed to process request: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  });
};

// Setup direct message handler for content script requests
browser.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  if (message?.type === 'GET_CURRENT_TAB_ID' && sender.tab?.id) {
    const response: GetCurrentTabIdResponseMsg = {
      tabId: sender.tab.id
    };
    sendResponse(response);
    return true;
  }
  
  // Handle unified conversation storage requests
  if (message?.type === 'GET_ALL_CONVERSATIONS') {
    handleGetAllConversations().then(conversations => {
      sendResponse({ conversations });
    }).catch(error => {
      console.error('Sol Background: Error getting all conversations:', error);
      sendResponse({ conversations: [] });
    });
    return true;
  }
  
  if (message?.type === 'GET_CONVERSATION') {
    handleGetConversation(message.id).then(conversation => {
      sendResponse({ conversation });
    }).catch(error => {
      console.error('Sol Background: Error getting conversation:', error);
      sendResponse({ conversation: null });
    });
    return true;
  }
  
  if (message?.type === 'SAVE_CONVERSATION') {
    handleSaveConversation(message.conversation).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Sol Background: Error saving conversation:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (message?.type === 'UPDATE_CONVERSATION') {
    handleUpdateConversation(message.id, message.updates).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Sol Background: Error updating conversation:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (message?.type === 'DELETE_CONVERSATION') {
    handleDeleteConversation(message.id).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Sol Background: Error deleting conversation:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (message?.type === 'DELETE_ALL_CONVERSATIONS') {
    handleDeleteAllConversations().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Sol Background: Error deleting all conversations:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  return true; // Always return true to keep channel open
});

// Unified conversation storage handlers
async function handleGetAllConversations() {
  try {
    // Get conversations from background storage (unified approach)
    const dbConversations = await storage.database.conversations
      .orderBy('updatedAt')
      .reverse()
      .toArray();
    
    // Convert to expected format with messages
    const conversations = await Promise.all(
      dbConversations.map(async (dbConv) => {
        const messages = await storage.database.messages
          .where('[convId+idx]')
          .between([dbConv.id, 0], [dbConv.id, Infinity])
          .toArray();
        
        return {
          id: dbConv.id,
          title: dbConv.title,
          url: dbConv.url,
          messages: messages.map(msg => {
            const textPart = msg.parts.find(p => p.type === 'text');
            return {
              type: msg.type,
              content: textPart?.text || '',
              timestamp: msg.timestamp,
              tabIds: msg.tabIds
            };
          }),
          createdAt: dbConv.createdAt,
          updatedAt: dbConv.updatedAt
        };
      })
    );
    
    return conversations;
  } catch (error) {
    console.error('Sol Background: Error in handleGetAllConversations:', error);
    return [];
  }
}

async function handleGetConversation(id: string) {
  try {
    const dbConversation = await storage.database.conversations.get(id);
    if (!dbConversation) {
      return null;
    }

    const messages = await storage.database.messages
      .where('[convId+idx]')
      .between([id, 0], [id, Infinity])
      .toArray();

    return {
      id: dbConversation.id,
      title: dbConversation.title,
      url: dbConversation.url,
      messages: messages.map(msg => {
        const textPart = msg.parts.find(p => p.type === 'text');
        return {
          type: msg.type,
          content: textPart?.text || '',
          timestamp: msg.timestamp,
          tabIds: msg.tabIds
        };
      }),
      createdAt: dbConversation.createdAt,
      updatedAt: dbConversation.updatedAt
    };
  } catch (error) {
    console.error('Sol Background: Error in handleGetConversation:', error);
    return null;
  }
}

async function handleSaveConversation(conversation: any) {
  try {
    // Save conversation to background storage
    await storage.database.conversations.put({
      id: conversation.id,
      title: conversation.title,
      url: conversation.url,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    
    // Save messages
    for (let i = 0; i < conversation.messages.length; i++) {
      const msg = conversation.messages[i];
      await storage.database.messages.put({
        id: `${conversation.id}_${i}`,
        convId: conversation.id,
        idx: i,
        type: msg.type,
        parts: [{ type: 'text', text: msg.content }],
        timestamp: msg.timestamp,
        tabIds: msg.tabIds
      });
    }
  } catch (error) {
    console.error('Sol Background: Error in handleSaveConversation:', error);
    throw error;
  }
}

async function handleUpdateConversation(id: string, updates: any) {
  try {
    // Update conversation metadata
    const convUpdates: any = { updatedAt: Date.now() };
    if (updates.title !== undefined) {
      convUpdates.title = updates.title;
    }
    
    await storage.database.conversations.update(id, convUpdates);

    // Handle message updates if provided
    if (updates.messages) {
      // Clear existing messages for this conversation
      await storage.database.messages.where('convId').equals(id).delete();
      
      // Add all new messages
      for (let i = 0; i < updates.messages.length; i++) {
        const message = updates.messages[i];
        await storage.database.messages.put({
          id: `${id}_msg_${i}`,
          convId: id,
          idx: i,
          type: message.type,
          parts: [{ type: 'text', text: message.content }],
          timestamp: message.timestamp,
          tabIds: message.tabIds
        });
      }
    }
  } catch (error) {
    console.error('Sol Background: Error in handleUpdateConversation:', error);
    throw error;
  }
}

async function handleDeleteConversation(id: string) {
  try {
    await storage.database.transaction('rw', storage.database.conversations, storage.database.messages, async () => {
      await storage.database.conversations.delete(id);
      await storage.database.messages.where('convId').equals(id).delete();
    });
  } catch (error) {
    console.error('Sol Background: Error in handleDeleteConversation:', error);
    throw error;
  }
}

async function handleDeleteAllConversations() {
  try {
    await storage.database.transaction('rw', storage.database.conversations, storage.database.messages, async () => {
      await storage.database.conversations.clear();
      await storage.database.messages.clear();
    });
  } catch (error) {
    console.error('Sol Background: Error in handleDeleteAllConversations:', error);
    throw error;
  }
}

// Initialize everything
setupMessageHandlers();
keepAlive();

browser.runtime.onStartup.addListener(async () => {
  await checkAndResetSchema();
});

// Clean up snapshots when tabs are closed or updated
browser.tabs.onRemoved.addListener((tabId) => {
  snapshotManager.clearTab(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
  }
});

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const url = browser.runtime.getURL('src/pages/dashboard/index.html');
    browser.tabs.create({ url: url });
  }
});