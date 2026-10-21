export type View = 'talk' | 'journal' | 'words' | 'settings';
export type Role = 'user' | 'assistant';

export interface Preferences {
  languageID: string;
  meaningLanguage: string;
  conversationTheme: string;
  colorScheme: 'system' | 'light' | 'dark';
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  meaning: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  languageID: string;
  themeID: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  messages?: Message[];
}

export interface VocabularyItem {
  id: string;
  languageID: string;
  phrase: string;
  meaning: string;
  note: string | null;
  sourceConversationID: string | null;
  createdAt: string;
}

export interface AISettings {
  provider: 'siwc' | 'compatible';
  apiBase: string;
  model: string;
  apiStyle: 'responses' | 'chat_completions';
  nativeWebSearch: boolean;
  hasCompatibleKey: boolean;
  siwcConnected: boolean;
  siwcEmail: string | null;
  siwcScopeGranted: boolean;
  secretsEncryptionConfigured: boolean;
}

export interface VoiceBudget {
  enabled: boolean;
  reason: string | null;
  periodStart: string | null;
  availableMilliseconds: number;
  reservedMilliseconds: number;
  usedMilliseconds: number;
  limitUSD: number;
}

export interface Bootstrap {
  preferences: Preferences;
  conversations: Conversation[];
  vocabulary: VocabularyItem[];
  ai: AISettings;
  voice: VoiceBudget;
}

export interface FullConversation extends Conversation {
  messages: Message[];
}
