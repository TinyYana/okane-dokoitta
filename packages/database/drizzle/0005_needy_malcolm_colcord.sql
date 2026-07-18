CREATE TYPE "okane_dokoitta"."security_kind" AS ENUM('stock', 'etf');--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."holdings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"security_id" uuid NOT NULL,
	"quantity_micro" bigint NOT NULL,
	"cost_basis_minor" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."investment_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"settlement_account_id" uuid NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."market_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"security_id" uuid NOT NULL,
	"price" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"source" "okane_dokoitta"."rate_source" DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."securities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"market" text NOT NULL,
	"currency" char(3) NOT NULL,
	"kind" "okane_dokoitta"."security_kind" DEFAULT 'stock' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transactions" ADD COLUMN "security_id" uuid;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transactions" ADD COLUMN "quantity_micro" bigint;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."users" ADD COLUMN "base_currency" char(3) DEFAULT 'TWD' NOT NULL;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."holdings" ADD CONSTRAINT "holdings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."holdings" ADD CONSTRAINT "holdings_asset_account_id_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."holdings" ADD CONSTRAINT "holdings_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "okane_dokoitta"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."investment_accounts" ADD CONSTRAINT "investment_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."investment_accounts" ADD CONSTRAINT "investment_accounts_settlement_account_id_accounts_id_fk" FOREIGN KEY ("settlement_account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."investment_accounts" ADD CONSTRAINT "investment_accounts_asset_account_id_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "okane_dokoitta"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."market_prices" ADD CONSTRAINT "market_prices_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "okane_dokoitta"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."securities" ADD CONSTRAINT "securities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holdings_asset_security_unique" ON "okane_dokoitta"."holdings" USING btree ("asset_account_id","security_id");--> statement-breakpoint
CREATE INDEX "investment_accounts_user_idx" ON "okane_dokoitta"."investment_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_accounts_asset_unique" ON "okane_dokoitta"."investment_accounts" USING btree ("asset_account_id");--> statement-breakpoint
CREATE INDEX "market_prices_security_asof_idx" ON "okane_dokoitta"."market_prices" USING btree ("security_id","as_of");--> statement-breakpoint
CREATE INDEX "securities_user_idx" ON "okane_dokoitta"."securities" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."transactions" ADD CONSTRAINT "transactions_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "okane_dokoitta"."securities"("id") ON DELETE no action ON UPDATE no action;