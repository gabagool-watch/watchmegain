#!/bin/bash

# Setup script for PnL Tracker

set -e

echo "🚀 Setting up PnL Tracker..."

# Check for required tools
command -v node >/dev/null 2>&1 || { echo "❌ Node.js is required but not installed."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ npm is required but not installed."; exit 1; }

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Create .env if it doesn't exist
if [ ! -f .env ]; then
  echo "📝 Creating .env file..."
  cp env.example .env
  echo "⚠️  Please edit .env with your settings"
fi

# Check if Docker is available for database
if command -v docker-compose >/dev/null 2>&1; then
  echo "🐳 Starting PostgreSQL with Docker..."
  docker-compose up -d postgres redis
  
  # Wait for PostgreSQL to be ready
  echo "⏳ Waiting for PostgreSQL to be ready..."
  sleep 5
fi

# Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# Push schema to database
echo "📊 Setting up database..."
npx prisma db push

# Seed the database
echo "🌱 Seeding database with sample data..."
npm run db:seed

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start the development server:"
echo "  npm run dev"
echo ""
echo "To start with Docker:"
echo "  docker-compose up -d"
echo ""
echo "Visit http://localhost:3000"
