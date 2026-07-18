CREATE TYPE "okane_dokoitta"."notification_channel" AS ENUM('discord', 'web_push');--> statement-breakpoint
CREATE TYPE "okane_dokoitta"."notification_privacy_mode" AS ENUM('full', 'fuzzy', 'anomaly_only', 'hidden');--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."discord_link_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_username" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_link_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."discord_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_username" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "discord_links_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "discord_links_discord_user_id_unique" UNIQUE("discord_user_id")
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."notification_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"dedup_key" text NOT NULL,
	"channel" "okane_dokoitta"."notification_channel" NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"privacy_mode" "okane_dokoitta"."notification_privacy_mode" DEFAULT 'fuzzy' NOT NULL,
	"discord_enabled" boolean DEFAULT true NOT NULL,
	"web_push_enabled" boolean DEFAULT true NOT NULL,
	"quiet_hours_start_minute" smallint,
	"quiet_hours_end_minute" smallint,
	"muted_event_types" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."web_push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."discord_links" ADD CONSTRAINT "discord_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."notification_log" ADD CONSTRAINT "notification_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."web_push_subscriptions" ADD CONSTRAINT "web_push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discord_links_user_idx" ON "okane_dokoitta"."discord_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_log_user_dedup_channel_unique" ON "okane_dokoitta"."notification_log" USING btree ("user_id","dedup_key","channel");--> statement-breakpoint
CREATE INDEX "notification_log_user_event_idx" ON "okane_dokoitta"."notification_log" USING btree ("user_id","event_type","sent_at");--> statement-breakpoint
CREATE INDEX "web_push_subscriptions_user_idx" ON "okane_dokoitta"."web_push_subscriptions" USING btree ("user_id");