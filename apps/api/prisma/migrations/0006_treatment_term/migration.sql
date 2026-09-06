-- CreateTable
CREATE TABLE "treatment_term" (
    "id" TEXT NOT NULL,
    "tx_code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "plain_en" TEXT NOT NULL,
    "plain_sw" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "min_keph_level" INTEGER NOT NULL,
    "synonyms" TEXT[],
    "requires_consent" BOOLEAN NOT NULL DEFAULT false,
    "review_status" TEXT NOT NULL,

    CONSTRAINT "treatment_term_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "treatment_term_tx_code_key" ON "treatment_term"("tx_code");

-- CreateIndex
CREATE INDEX "treatment_term_category_idx" ON "treatment_term"("category");

-- CreateIndex
CREATE INDEX "treatment_term_min_keph_level_idx" ON "treatment_term"("min_keph_level");


