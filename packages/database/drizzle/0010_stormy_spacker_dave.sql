CREATE TABLE "okane_dokoitta"."ai_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"api_key_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."ai_settings" ADD CONSTRAINT "ai_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;