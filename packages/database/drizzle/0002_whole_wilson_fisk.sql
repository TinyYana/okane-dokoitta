CREATE TABLE "okane_dokoitta"."auth_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_challenges_expiry_idx" ON "okane_dokoitta"."auth_challenges" USING btree ("expires_at");