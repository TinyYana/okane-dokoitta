CREATE TABLE "okane_dokoitta"."statement_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"import_file_id" uuid NOT NULL,
	"institution" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"statement_date" date NOT NULL,
	"due_date" date NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_groups_import_file_id_unique" UNIQUE("import_file_id")
);
--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."statements" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."statement_groups" ADD CONSTRAINT "statement_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."statement_groups" ADD CONSTRAINT "statement_groups_import_file_id_import_files_id_fk" FOREIGN KEY ("import_file_id") REFERENCES "okane_dokoitta"."import_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "statement_groups_user_date_idx" ON "okane_dokoitta"."statement_groups" USING btree ("user_id","statement_date");--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."statements" ADD CONSTRAINT "statements_group_id_statement_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "okane_dokoitta"."statement_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "statements_group_card_unique" ON "okane_dokoitta"."statements" USING btree ("group_id","credit_card_account_id");