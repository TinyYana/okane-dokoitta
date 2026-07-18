CREATE TYPE "okane_dokoitta"."recur_kind" AS ENUM('expense', 'invest_buy');--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."recurring_rules" ADD COLUMN "kind" "okane_dokoitta"."recur_kind" DEFAULT 'expense' NOT NULL;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."recurring_rules" ADD COLUMN "investment_account_id" uuid;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."recurring_rules" ADD COLUMN "security_id" uuid;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."recurring_rules" ADD CONSTRAINT "recurring_rules_investment_account_id_investment_accounts_id_fk" FOREIGN KEY ("investment_account_id") REFERENCES "okane_dokoitta"."investment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."recurring_rules" ADD CONSTRAINT "recurring_rules_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "okane_dokoitta"."securities"("id") ON DELETE no action ON UPDATE no action;