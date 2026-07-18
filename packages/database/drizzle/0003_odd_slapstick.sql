CREATE TYPE "okane_dokoitta"."alias_source" AS ENUM('user', 'rule', 'ai');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."audit_candidate_kind" AS ENUM('match', 'missing_in_ledger', 'missing_in_statement', 'amount_mismatch', 'date_mismatch', 'wrong_card', 'duplicate', 'refund_unlinked', 'deferred_posting', 'installment_issue', 'unresolved_difference');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."audit_session_status" AS ENUM('created', 'parsing', 'matching', 'reviewing', 'completed', 'archived', 'superseded');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."candidate_decision" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."import_file_status" AS ENUM('uploaded', 'parsed', 'failed', 'purged');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."patch_kind" AS ENUM('create_transaction', 'update_transaction', 'merge_duplicates', 'link_refund', 'assign_statement', 'create_expected', 'adjust_amount');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."patch_origin" AS ENUM('rule', 'ai', 'user');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."patch_status" AS ENUM('proposed', 'accepted', 'rejected', 'applied', 'failed');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."statement_status" AS ENUM('open', 'closed', 'due', 'paid', 'superseded');--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."audit_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"statement_item_id" uuid,
	"transaction_id" uuid,
	"kind" "okane_dokoitta"."audit_candidate_kind" NOT NULL,
	"score" text NOT NULL,
	"reasoning_codes" text[] DEFAULT '{}' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"explanation" text NOT NULL,
	"decision" "okane_dokoitta"."candidate_decision" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."audit_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"status" "okane_dokoitta"."audit_session_status" DEFAULT 'created' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."import_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_path" text NOT NULL,
	"importer_id" text,
	"status" "okane_dokoitta"."import_file_status" DEFAULT 'uploaded' NOT NULL,
	"retain_until" date NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "okane_dokoitta"."job_status" DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."merchant_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"normalized" text NOT NULL,
	"source" "okane_dokoitta"."alias_source" NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."proposed_patches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"candidate_id" uuid,
	"kind" "okane_dokoitta"."patch_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"origin" "okane_dokoitta"."patch_origin" NOT NULL,
	"status" "okane_dokoitta"."patch_status" DEFAULT 'proposed' NOT NULL,
	"failure_code" text,
	"applied_at" timestamp with time zone,
	"applied_audit_log_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."statement_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"merchant_raw" text NOT NULL,
	"merchant_normalized" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"occurred_date" date,
	"posted_date" date,
	"card_last4" char(4),
	"installment_current" smallint,
	"installment_total" smallint,
	"raw" jsonb NOT NULL,
	"matched_transaction_id" uuid
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credit_card_account_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"statement_date" date NOT NULL,
	"due_date" date NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"minimum_due_minor" bigint,
	"previous_balance_minor" bigint,
	"status" "okane_dokoitta"."statement_status" DEFAULT 'closed' NOT NULL,
	"import_file_id" uuid,
	"audit_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."audit_candidates" ADD CONSTRAINT "audit_candidates_session_id_audit_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "okane_dokoitta"."audit_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."audit_candidates" ADD CONSTRAINT "audit_candidates_statement_item_id_statement_items_id_fk" FOREIGN KEY ("statement_item_id") REFERENCES "okane_dokoitta"."statement_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."audit_candidates" ADD CONSTRAINT "audit_candidates_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "okane_dokoitta"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."audit_sessions" ADD CONSTRAINT "audit_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."audit_sessions" ADD CONSTRAINT "audit_sessions_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "okane_dokoitta"."statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."import_files" ADD CONSTRAINT "import_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."merchant_aliases" ADD CONSTRAINT "merchant_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."proposed_patches" ADD CONSTRAINT "proposed_patches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."proposed_patches" ADD CONSTRAINT "proposed_patches_session_id_audit_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "okane_dokoitta"."audit_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."proposed_patches" ADD CONSTRAINT "proposed_patches_candidate_id_audit_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "okane_dokoitta"."audit_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."proposed_patches" ADD CONSTRAINT "proposed_patches_applied_audit_log_id_audit_logs_id_fk" FOREIGN KEY ("applied_audit_log_id") REFERENCES "okane_dokoitta"."audit_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."statement_items" ADD CONSTRAINT "statement_items_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "okane_dokoitta"."statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."statement_items" ADD CONSTRAINT "statement_items_matched_transaction_id_transactions_id_fk" FOREIGN KEY ("matched_transaction_id") REFERENCES "okane_dokoitta"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."statements" ADD CONSTRAINT "statements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."statements" ADD CONSTRAINT "statements_credit_card_account_id_accounts_id_fk" FOREIGN KEY ("credit_card_account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."statements" ADD CONSTRAINT "statements_import_file_id_import_files_id_fk" FOREIGN KEY ("import_file_id") REFERENCES "okane_dokoitta"."import_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_candidates_session_idx" ON "okane_dokoitta"."audit_candidates" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "audit_sessions_user_created_idx" ON "okane_dokoitta"."audit_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "import_files_user_created_idx" ON "okane_dokoitta"."import_files" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_status_available_idx" ON "okane_dokoitta"."jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_aliases_user_pattern_unique" ON "okane_dokoitta"."merchant_aliases" USING btree ("user_id","pattern");--> statement-breakpoint
CREATE INDEX "proposed_patches_user_session_idx" ON "okane_dokoitta"."proposed_patches" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_items_line_unique" ON "okane_dokoitta"."statement_items" USING btree ("statement_id","line_no");--> statement-breakpoint
CREATE INDEX "statements_user_card_date_idx" ON "okane_dokoitta"."statements" USING btree ("user_id","credit_card_account_id","statement_date");--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transactions" ADD CONSTRAINT "transactions_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "okane_dokoitta"."statements"("id") ON DELETE no action ON UPDATE no action;