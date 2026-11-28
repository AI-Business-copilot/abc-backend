CREATE TABLE "assistant_conversations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_conversations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "assistant_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "assistant_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL,
  "role" VARCHAR(20) NOT NULL,
  "content" TEXT NOT NULL,
  "required_permissions" TEXT[] NOT NULL,
  "evidence" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_messages_role_check" CHECK ("role" IN ('user', 'assistant')),
  CONSTRAINT "assistant_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "assistant_conversations_business_id_user_id_updated_at_idx" ON "assistant_conversations"("business_id", "user_id", "updated_at" DESC);
CREATE INDEX "assistant_messages_conversation_id_created_at_id_idx" ON "assistant_messages"("conversation_id", "created_at", "id");

ALTER TABLE "assistant_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_messages" ENABLE ROW LEVEL SECURITY;
