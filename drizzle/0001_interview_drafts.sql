CREATE TABLE "interview_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"event_slug" text,
	"team_slug" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"mobile" text NOT NULL,
	"company" text,
	"answers" integer[] NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"turn" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "responses" ADD COLUMN "intake_mode" text DEFAULT 'tap' NOT NULL;--> statement-breakpoint
CREATE INDEX "interview_drafts_updated_at_idx" ON "interview_drafts" USING btree ("updated_at");