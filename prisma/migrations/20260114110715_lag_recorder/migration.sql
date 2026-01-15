-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('OPEN', 'CLOSED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "tracked_wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "alias" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracked_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "condition_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "MarketStatus" NOT NULL DEFAULT 'OPEN',
    "outcomes" JSONB NOT NULL,
    "end_time" TIMESTAMP(3),
    "resolution_price" JSONB,
    "extra_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_time" TIMESTAMP(3) NOT NULL,
    "block_number" INTEGER NOT NULL,
    "outcome" INTEGER NOT NULL,
    "side" "TradeSide" NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "raw_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "outcome" INTEGER NOT NULL,
    "shares" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_entry_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realized_pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unrealized_pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_fees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "last_updated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshots" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "equity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realized_pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unrealized_pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume_30d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "open_positions" INTEGER NOT NULL DEFAULT 0,
    "raw_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_status" (
    "id" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "last_success" TIMESTAMP(3),
    "last_error" TEXT,
    "is_running" BOOLEAN NOT NULL DEFAULT false,
    "items_processed" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_samples" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "market_slug" TEXT,
    "condition_id" TEXT,
    "asset_id" TEXT,
    "side" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "is_best_bid" BOOLEAN,
    "is_best_ask" BOOLEAN,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "extra_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracked_wallets_address_key" ON "tracked_wallets"("address");

-- CreateIndex
CREATE UNIQUE INDEX "markets_condition_id_key" ON "markets"("condition_id");

-- CreateIndex
CREATE INDEX "trades_wallet_id_block_time_idx" ON "trades"("wallet_id", "block_time");

-- CreateIndex
CREATE INDEX "trades_market_id_idx" ON "trades"("market_id");

-- CreateIndex
CREATE UNIQUE INDEX "trades_tx_hash_log_index_key" ON "trades"("tx_hash", "log_index");

-- CreateIndex
CREATE INDEX "positions_wallet_id_status_idx" ON "positions"("wallet_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "positions_wallet_id_market_id_outcome_key" ON "positions"("wallet_id", "market_id", "outcome");

-- CreateIndex
CREATE INDEX "snapshots_wallet_id_timestamp_idx" ON "snapshots"("wallet_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "sync_status_job_type_key" ON "sync_status"("job_type");

-- CreateIndex
CREATE INDEX "price_samples_source_symbol_observed_at_idx" ON "price_samples"("source", "symbol", "observed_at");

-- CreateIndex
CREATE INDEX "price_samples_condition_id_observed_at_idx" ON "price_samples"("condition_id", "observed_at");

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "tracked_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "tracked_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "tracked_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
