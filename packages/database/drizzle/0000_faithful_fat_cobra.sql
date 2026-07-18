CREATE SCHEMA "okane_dokoitta";
--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."account_kind" AS ENUM('asset', 'liability', 'income', 'expense', 'equity');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."account_subtype" AS ENUM('cash', 'bank', 'digital', 'e_wallet', 'credit_card', 'brokerage_settlement', 'investment_asset', 'other_asset', 'other_liability', 'category_income', 'category_expense', 'opening_balance');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."audit_actor" AS ENUM('user', 'system', 'discord', 'patch', 'sync');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."card_status" AS ENUM('active', 'frozen', 'cancelled');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."expected_status" AS ENUM('scheduled', 'matched', 'confirmed', 'missed', 'skipped');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."transaction_link_kind" AS ENUM('refund', 'installment_parent', 'fx_pair', 'duplicate_of', 'payment_for_statement', 'correction');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."mutation_op" AS ENUM('create', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."mutation_result" AS ENUM('applied', 'rejected_conflict', 'rejected_invalid', 'duplicate');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."rate_source" AS ENUM('manual', 'provider');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."recur_freq" AS ENUM('weekly', 'monthly', 'yearly', 'custom_days');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."transaction_source" AS ENUM('manual', 'import', 'recurring', 'discord_draft', 'patch');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."transaction_status" AS ENUM('draft', 'expected', 'pending', 'posted', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."transaction_type" AS ENUM('expense', 'income', 'transfer', 'card_payment', 'refund', 'invest_buy', 'invest_sell', 'dividend', 'fee', 'tax', 'adjustment');--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."account_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "okane_dokoitta"."account_kind" NOT NULL,
	"subtype" "okane_dokoitta"."account_subtype" NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"group_id" uuid,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"actor" "okane_dokoitta"."audit_actor" NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"mutation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."auth_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."credit_cards" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"card_name" text NOT NULL,
	"last4" char(4) NOT NULL,
	"credit_limit_minor" bigint,
	"limit_group_id" uuid,
	"statement_day" smallint NOT NULL,
	"due_day" smallint NOT NULL,
	"autopay_day" smallint,
	"autopay_account_id" uuid,
	"status" "okane_dokoitta"."card_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."credit_limit_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"limit_minor" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."exchange_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"base" char(3) NOT NULL,
	"quote" char(3) NOT NULL,
	"rate" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"source" "okane_dokoitta"."rate_source" DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."expected_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_id" uuid,
	"expected_date" date NOT NULL,
	"amount_minor" bigint,
	"currency" char(3) NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "okane_dokoitta"."expected_status" DEFAULT 'scheduled' NOT NULL,
	"matched_transaction_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."journal_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"description" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."journal_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."recurring_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"freq" "okane_dokoitta"."recur_freq" NOT NULL,
	"interval" smallint DEFAULT 1 NOT NULL,
	"day_of_month" smallint,
	"month" smallint,
	"custom_every_days" smallint,
	"amount_minor" bigint,
	"currency" char(3) NOT NULL,
	"amount_tolerance_minor" bigint DEFAULT 0 NOT NULL,
	"date_tolerance_days" smallint DEFAULT 3 NOT NULL,
	"account_id" uuid NOT NULL,
	"category_account_id" uuid,
	"merchant_hint" text,
	"active" boolean DEFAULT true NOT NULL,
	"next_expected_date" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."sync_mutations" (
	"mutation_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"op" "okane_dokoitta"."mutation_op" NOT NULL,
	"base_version" integer,
	"payload" jsonb NOT NULL,
	"result" "okane_dokoitta"."mutation_result" NOT NULL,
	"applied_version" integer,
	"error_code" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."transaction_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "okane_dokoitta"."transaction_link_kind" NOT NULL,
	"from_transaction_id" uuid NOT NULL,
	"to_transaction_id" uuid NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "okane_dokoitta"."transaction_type" NOT NULL,
	"status" "okane_dokoitta"."transaction_status" NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"from_account_id" uuid,
	"to_account_id" uuid,
	"category_account_id" uuid,
	"merchant_raw" text,
	"merchant_normalized" text,
	"note" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"authorized_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"statement_id" uuid,
	"statement_date" date,
	"due_date" date,
	"scheduled_payment_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"installment_current" smallint,
	"installment_total" smallint,
	"recurring_rule_id" uuid,
	"expected_transaction_id" uuid,
	"source" "okane_dokoitta"."transaction_source" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"ledger_time_zone" text DEFAULT 'Asia/Taipei' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."account_groups" ADD CONSTRAINT "account_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."accounts" ADD CONSTRAINT "accounts_group_id_account_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "okane_dokoitta"."account_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."auth_credentials" ADD CONSTRAINT "auth_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."credit_cards" ADD CONSTRAINT "credit_cards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."credit_cards" ADD CONSTRAINT "credit_cards_limit_group_id_credit_limit_groups_id_fk" FOREIGN KEY ("limit_group_id") REFERENCES "okane_dokoitta"."credit_limit_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."credit_cards" ADD CONSTRAINT "credit_cards_autopay_account_id_accounts_id_fk" FOREIGN KEY ("autopay_account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."credit_limit_groups" ADD CONSTRAINT "credit_limit_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."expected_transactions" ADD CONSTRAINT "expected_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."expected_transactions" ADD CONSTRAINT "expected_transactions_rule_id_recurring_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "okane_dokoitta"."recurring_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."expected_transactions" ADD CONSTRAINT "expected_transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."expected_transactions" ADD CONSTRAINT "expected_transactions_matched_transaction_id_transactions_id_fk" FOREIGN KEY ("matched_transaction_id") REFERENCES "okane_dokoitta"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."journal_entries" ADD CONSTRAINT "journal_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."journal_entries" ADD CONSTRAINT "journal_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "okane_dokoitta"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "okane_dokoitta"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."recurring_rules" ADD CONSTRAINT "recurring_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."recurring_rules" ADD CONSTRAINT "recurring_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."recurring_rules" ADD CONSTRAINT "recurring_rules_category_account_id_accounts_id_fk" FOREIGN KEY ("category_account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."sync_mutations" ADD CONSTRAINT "sync_mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transaction_links" ADD CONSTRAINT "transaction_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transaction_links" ADD CONSTRAINT "transaction_links_from_transaction_id_transactions_id_fk" FOREIGN KEY ("from_transaction_id") REFERENCES "okane_dokoitta"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transaction_links" ADD CONSTRAINT "transaction_links_to_transaction_id_transactions_id_fk" FOREIGN KEY ("to_transaction_id") REFERENCES "okane_dokoitta"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transactions" ADD CONSTRAINT "transactions_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transactions" ADD CONSTRAINT "transactions_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transactions" ADD CONSTRAINT "transactions_category_account_id_accounts_id_fk" FOREIGN KEY ("category_account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "okane_dokoitta"."accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_user_entity_idx" ON "okane_dokoitta"."audit_logs" USING btree ("user_id","entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expected_rule_date_unique" ON "okane_dokoitta"."expected_transactions" USING btree ("rule_id","expected_date");--> statement-breakpoint
CREATE INDEX "journal_entries_txn_idx" ON "okane_dokoitta"."journal_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "okane_dokoitta"."journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "okane_dokoitta"."journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "okane_dokoitta"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_user_occurred_idx" ON "okane_dokoitta"."transactions" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_user_from_idx" ON "okane_dokoitta"."transactions" USING btree ("user_id","from_account_id");--> statement-breakpoint
CREATE INDEX "transactions_user_to_idx" ON "okane_dokoitta"."transactions" USING btree ("user_id","to_account_id");