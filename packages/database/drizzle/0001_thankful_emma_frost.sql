CREATE TABLE "okane_dokoitta"."change_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."passkeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}' NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."registration_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."sync_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."totp_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"encrypted_secret" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "totp_credentials_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."sessions" ADD COLUMN "public_id" uuid;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."sessions" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "okane_dokoitta"."users" SET "is_admin" = true WHERE "id" = (SELECT "id" FROM "okane_dokoitta"."users" ORDER BY "created_at" LIMIT 1);--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."change_log" ADD CONSTRAINT "change_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."registration_invites" ADD CONSTRAINT "registration_invites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."registration_invites" ADD CONSTRAINT "registration_invites_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."sync_devices" ADD CONSTRAINT "sync_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."totp_credentials" ADD CONSTRAINT "totp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "okane_dokoitta"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_log_user_seq_idx" ON "okane_dokoitta"."change_log" USING btree ("user_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "passkeys_credential_id_idx" ON "okane_dokoitta"."passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "okane_dokoitta"."passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "okane_dokoitta"."recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invites_code_hash_idx" ON "okane_dokoitta"."registration_invites" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "sync_devices_user_idx" ON "okane_dokoitta"."sync_devices" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."sessions" ADD CONSTRAINT "sessions_device_id_sync_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "okane_dokoitta"."sync_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."sessions" ADD CONSTRAINT "sessions_public_id_unique" UNIQUE("public_id");
