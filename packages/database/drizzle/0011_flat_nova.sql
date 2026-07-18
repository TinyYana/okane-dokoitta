ALTER TABLE "okane_dokoitta"."investment_accounts" ADD COLUMN "currency" char(3) DEFAULT 'TWD' NOT NULL;--> statement-breakpoint
UPDATE "okane_dokoitta"."investment_accounts" ia SET "currency" = a."currency" FROM "okane_dokoitta"."accounts" a WHERE a."id" = ia."settlement_account_id";
