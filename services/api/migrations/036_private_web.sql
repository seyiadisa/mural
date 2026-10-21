-- Private, owner-operated browser client. Web conversations are separate from native archives.
CREATE TABLE web_host_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ext_agent_host_id text NOT NULL CHECK (ext_agent_host_id ~ '^urn:uuid:[0-9a-f-]{36}$')
);
INSERT INTO web_host_identity(singleton, ext_agent_host_id)
VALUES (true, 'urn:uuid:' || gen_random_uuid()::text);

CREATE TABLE web_preferences (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  language_id text NOT NULL DEFAULT 'nb-NO',
  meaning_language text NOT NULL DEFAULT 'English',
  conversation_theme text NOT NULL DEFAULT 'introductions',
  color_scheme text NOT NULL DEFAULT 'system' CHECK (color_scheme IN ('system','light','dark')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE web_ai_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'siwc' CHECK (provider IN ('siwc','compatible')),
  api_base text NOT NULL DEFAULT 'https://api.openai.com/v1',
  model text NOT NULL DEFAULT 'gpt-6-luna',
  api_style text NOT NULL DEFAULT 'responses' CHECK (api_style IN ('responses','chat_completions')),
  native_web_search boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE web_siwc_credentials (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  scopes text[] NOT NULL,
  access_token_expires_at timestamptz NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_id, subject)
);

CREATE TABLE web_compatible_secrets (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE web_conversations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  language_id text NOT NULL,
  theme_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, id)
);
CREATE INDEX web_conversations_recent ON web_conversations(account_id, updated_at DESC);

CREATE TABLE web_messages (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
  meaning text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(account_id, conversation_id) REFERENCES web_conversations(account_id, id) ON DELETE CASCADE,
  UNIQUE(conversation_id, id)
);
CREATE INDEX web_messages_conversation ON web_messages(account_id, conversation_id, created_at, id);

CREATE TABLE web_vocabulary (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  language_id text NOT NULL,
  phrase text NOT NULL CHECK (char_length(phrase) BETWEEN 1 AND 500),
  meaning text NOT NULL CHECK (char_length(meaning) BETWEEN 1 AND 2000),
  note text,
  source_conversation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(account_id, source_conversation_id) REFERENCES web_conversations(account_id, id) ON DELETE SET NULL (source_conversation_id)
);
CREATE INDEX web_vocabulary_recent ON web_vocabulary(account_id, created_at DESC);

CREATE TABLE web_voice_periods (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  granted_ms bigint NOT NULL CHECK (granted_ms = 12000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id, period_start)
);
-- Keep the private web app's monthly allowance separate from any pre-existing minute balance.
-- The hosted session remains the source of truth for settled usage and unresolved reservations.
CREATE TABLE web_voice_sessions (
  account_id uuid NOT NULL,
  period_start date NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  reserved_ms bigint NOT NULL CHECK (reserved_ms BETWEEN 15000 AND 600000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,idempotency_key),
  FOREIGN KEY(account_id,period_start) REFERENCES web_voice_periods(account_id,period_start) ON DELETE CASCADE
);
CREATE INDEX web_voice_sessions_period ON web_voice_sessions(account_id,period_start,created_at);
