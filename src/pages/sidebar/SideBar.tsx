import '@src/utils/logger';
import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { MemoisedMessages, useCopyMessage, ChatHeader, useConversationService, useChatInput } from '@src/components/index';
import TabChipRow from '../../components/shared/TabChipRow';
import InputArea from '../../components/shared/InputArea';

interface SideBarProps {
  position?: string;
  colorScheme?: 'light' | 'dark';
}

export const SideBar: React.FC<SideBarProps> = ({ position: initialPosition = 'left', colorScheme }) => {
  // UI-specific state
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [position, setPosition] = useState<string>(initialPosition);
  const [hasAutoAddedCurrentTab, setHasAutoAddedCurrentTab] = useState(false);
  const [currentTabId, setCurrentTabId] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState<string>('');

  // Refs
  const sideBarRef = useRef<HTMLDivElement>(null);
  const mountTimeRef = useRef<number>(Date.now());
  
  // Custom hooks for chat functionality
  const { copiedMessageIndex, handleCopyMessage } = useCopyMessage();
  const conversationService = useConversationService();
  const chatInput = useChatInput();
  
  // Chat header handlers
  const handleNewConversation = async () => {
    try {
      await conversationService.createNewConversation();
    } catch (error) {
      console.error('Sol SideBar: Failed to create new conversation:', error);
    }
  };

  const handleConversationSelect = async (conversationId: string) => {
    try {
      await conversationService.switchToConversation(conversationId);
    } catch (error) {
      console.error('Sol SideBar: Failed to switch conversation:', error);
    }
  };
  
  // Effects
  useEffect(() => {
    setIsVisible(true);
    chatInput.inputRef.current?.focus();
  }, []);

  // Update position when props change
  useEffect(() => {
    setPosition(initialPosition);
  }, [initialPosition]);

  // Initialize messaging system to receive updates from controller
  useEffect(() => {
    // For shadow DOM, we'll handle tab info through the shadow host element
    const handleShadowMessage = (event: CustomEvent) => {
      const message = event.detail;
      if (message.type === 'TAB_INFO_RESPONSE') {
        setCurrentTabId(message.tabId);
        setPageUrl(message.url);
      }
    };

    // Get the shadow host element and listen for custom events
    const shadowHost = document.querySelector('sol-overlay-container') as HTMLElement;
    if (shadowHost) {
      shadowHost.addEventListener('sol-shadow-message', handleShadowMessage as EventListener);
      
      // Request current tab info through shadow event
      shadowHost.dispatchEvent(new CustomEvent('sol-shadow-message', {
        detail: { type: 'GET_CURRENT_TAB', requestId: 'sidebar-init' },
        bubbles: false,
        composed: false
      }));
    }

    return () => {
      if (shadowHost) {
        shadowHost.removeEventListener('sol-shadow-message', handleShadowMessage as EventListener);
      }
    };
  }, []);

  // Auto-add current tab when SideBar opens (only once)
  useEffect(() => {
    if (currentTabId && chatInput.availableTabs.length > 0 && !hasAutoAddedCurrentTab) {
      const currentTab = chatInput.availableTabs.find(tab => tab.id === currentTabId);
      if (currentTab) {
        chatInput.handleTabReAdd(currentTab);
        setHasAutoAddedCurrentTab(true);
      }
    }
  }, [currentTabId, chatInput.availableTabs, hasAutoAddedCurrentTab, chatInput.handleTabReAdd]);

  // Apply color scheme
  useEffect(() => {
    if (colorScheme) {
      (document.documentElement as HTMLElement).style.colorScheme = colorScheme;
      (document.documentElement as HTMLElement).style.background = 'transparent';
      (document.body as HTMLElement).style.background = 'transparent';
    }
  }, [colorScheme]);

  // Close trigger logic
  useLayoutEffect(() => {
    const messageHandler = (event: MessageEvent) => {
      if (event.data?.type === 'sol-trigger-close') {
        handleClose();
      }
    };

    window.addEventListener('message', messageHandler);

    return () => {
      window.removeEventListener('message', messageHandler);
    };
  }, []);

  const handleClose = () => {
    if (Date.now() - mountTimeRef.current < 200) return;
    
    setIsClosing(true);
    setIsVisible(false);
    
    setTimeout(() => {
      // Send message through shadow DOM event system
      const hostElement = document.querySelector('#sol-sidebar-container');
      if (hostElement) {
        hostElement.dispatchEvent(new CustomEvent('sol-shadow-message', {
          detail: { type: 'sol-close-sidebar' },
          bubbles: false,
          composed: false
        }));
      }
    }, 300);
  };

  const getPositionClasses = (pos: string) => {
    switch (pos) {
      case 'left': return 'left-0 top-0 origin-left';
      case 'right': return 'right-0 top-0 origin-right';
      default: return 'left-0 top-0 origin-left';
    }
  };

  return (
    <div 
      ref={sideBarRef}
      className={`fixed z-[2147483647] h-screen transition-all duration-300 ease-in-out sol-font-inter ${getPositionClasses(position)}`}
      style={{
        opacity: isVisible ? 1 : 0,
        transform: `scale(${isVisible && !isClosing ? 1 : 0.95}) translateX(${isVisible && !isClosing ? 0 : position === 'left' ? '-20px' : '20px'})`,
        width: '500px'
      }}
      onKeyDown={(e) => {
        // Prevent keyboard events from bubbling to page to avoid triggering page shortcuts
        e.stopPropagation();
      }}
      onKeyUp={(e) => {
        // Prevent keyup events from bubbling to the page
        e.stopPropagation();
      }}
      onKeyPress={(e) => {
        // Prevent keypress events from bubbling to the page
        e.stopPropagation();
      }}
      tabIndex={0}
    >
      <div 
        className={`h-full backdrop-blur-[16px] ${position === 'right' ? 'border-l-[0.5px]' : 'border-r-[0.5px]'} border-black/[0.07] transition-all duration-300 ease-in-out sol-conversation-shadow sol-font-inter flex flex-col relative`}
        style={{ 
          backgroundColor: 'rgba(255, 255, 255, 0.8)'
        }}
      >
        {/* Chat Header - fixed at top */}
        <div className="flex-shrink-0 p-4 border-b border-black/5">
          <ChatHeader
            conversations={conversationService.conversations}
            activeConversationId={conversationService.activeConversationId}
            onConversationSelect={handleConversationSelect}
            onNewConversation={handleNewConversation}
            showExpandButton={false}
            showCloseButton={true}
            onClose={handleClose}
          />
        </div>

        {/* Tab Chips Row */}
        {chatInput.selectedTabChips.length > 0 && (
          <div className="flex-shrink-0 px-4 py-2 border-b border-black/5">
            <TabChipRow
              tabs={chatInput.selectedTabChips}
              onRemove={chatInput.handleTabRemoveById}
            />
          </div>
        )}

        {/* Messages Area - scrollable */}
        <div className="flex-1 overflow-y-auto p-4">
          {conversationService.messages.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center text-gray-400">
                <p className="text-sm">Start a conversation</p>
              </div>
            </div>
          ) : (
            <MemoisedMessages
              messages={conversationService.messages}
              onCopyMessage={handleCopyMessage}
              copiedMessageIndex={copiedMessageIndex}
              isStreaming={chatInput.isStreaming}
              availableTabs={chatInput.availableTabs}
              onTabReAdd={chatInput.handleTabReAdd}
            />
          )}
        </div>

        {/* Input Area - fixed at bottom */}
        <div className="flex-shrink-0 p-4 border-t border-black/5">
          <InputArea
            input={chatInput.input}
            onInputChange={chatInput.handleInputChange}
            onInputKeyDown={chatInput.handleInputKeyDown}
            inputRef={chatInput.inputRef}
            showDropdown={chatInput.showDropdown}
            filteredTabs={chatInput.filteredTabs}
            dropdownSelectedIndex={chatInput.dropdownSelectedIndex}
            insertTabMention={chatInput.insertTabMention}
            dropdownRef={chatInput.dropdownRef}
            setDropdownSelectedIndex={chatInput.setDropdownSelectedIndex}
            truncateTitle={chatInput.truncateTitle}
            searchTerm={chatInput.searchTerm}
            onSubmit={chatInput.handleSubmit}
            isStreaming={chatInput.isStreaming}
            showCloseButton={false}
            placeholder="Ask a question..."
          />
        </div>
      </div>
    </div>
  );
};

export default SideBar; 