ALTER TYPE "okane_dokoitta"."patch_kind" ADD VALUE 'acknowledge_unresolved';--> statement-breakpoint
CREATE TABLE "okane_dokoitta"."instance_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
UPDATE "okane_dokoitta"."sessions"
SET "public_id" = (
	substring(md5("token_hash"), 1, 8) || '-' ||
	substring(md5("token_hash"), 9, 4) || '-7' ||
	substring(md5("token_hash"), 14, 3) || '-8' ||
	substring(md5("token_hash"), 18, 3) || '-' ||
	substring(md5("token_hash"), 21, 12)
)::uuid
WHERE "public_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "okane_dokoitta"."sessions" ALTER COLUMN "public_id" SET NOT NULL;
