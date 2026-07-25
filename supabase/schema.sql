-- ARHMS Database Schema for Supabase
-- Run this in the SQL Editor of your Supabase project

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (extends Supabase Auth)
CREATE TABLE IF NOT EXISTS public.users (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone_number TEXT NOT NULL UNIQUE,
  role TEXT DEFAULT 'customer' CHECK (role IN ('customer', 'agent', 'sub-admin', 'admin')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive')),
  agent_expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Wallets table
CREATE TABLE IF NOT EXISTS public.wallets (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  balance DECIMAL(12, 2) DEFAULT 0.00,
  total_credited DECIMAL(12, 2) DEFAULT 0.00,
  total_spent DECIMAL(12, 2) DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Wallet transactions
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  wallet_id UUID REFERENCES public.wallets(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
  amount DECIMAL(12, 2) NOT NULL,
  description TEXT NOT NULL,
  reference TEXT,
  source TEXT NOT NULL CHECK (source IN ('payment', 'refund', 'admin', 'purchase')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Wallet payments
CREATE TABLE IF NOT EXISTS public.wallet_payments (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  wallet_id UUID REFERENCES public.wallets(id) ON DELETE CASCADE NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  fee DECIMAL(12, 2) DEFAULT 0.00,
  total_amount DECIMAL(12, 2) NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  provider TEXT DEFAULT 'paystack',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  provider_reference TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Data packages
CREATE TABLE IF NOT EXISTS public.data_packages (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('MTN', 'Telecel', 'AT-iShare', 'AT-BigTime')),
  size TEXT NOT NULL,
  price DECIMAL(12, 2) NOT NULL,
  cost_price DECIMAL(12, 2) DEFAULT 0.00, -- Added cost price
  description TEXT,
  is_available BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Orders
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  phone_number TEXT NOT NULL,
  network TEXT NOT NULL,
  size TEXT NOT NULL,
  price DECIMAL(12, 2) NOT NULL,
  cost_price DECIMAL(12, 2) DEFAULT 0.00, -- Snapshot of cost price
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  payment_status TEXT DEFAULT 'paid' CHECK (payment_status IN ('paid', 'refunded')),
  reference_code TEXT NOT NULL UNIQUE,
  fulfillment_method TEXT DEFAULT 'auto' CHECK (fulfillment_method IN ('auto', 'manual', 'codecraft', 'datakazina', 'kingflexy', 'eazydata', 'agentportal')),
  codecraft_reference TEXT,
  dakazina_reference TEXT,
  agentportal_reference TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('order_update', 'complaint_resolved', 'payment_success', 'balance_updated', 'system')),
  is_read BOOLEAN DEFAULT false,
  action_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Complaints
CREATE TABLE IF NOT EXISTS public.complaints (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'resolved', 'rejected')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  resolution_notes TEXT,
  evidence JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- MTN Fulfillment Tracking
CREATE TABLE IF NOT EXISTS public.mtn_fulfillment_tracking (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  api_response JSONB,
  retry_count INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fulfillment Logs (for CodeCraft)
CREATE TABLE IF NOT EXISTS public.fulfillment_logs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  api_response JSONB,
  codecraft_reference TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Admin Settings
CREATE TABLE IF NOT EXISTS public.admin_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Phone Blacklist
CREATE TABLE IF NOT EXISTS public.phone_blacklist (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  phone_number TEXT NOT NULL UNIQUE,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- AFA Orders (Agent Application)
CREATE TABLE IF NOT EXISTS public.afa_orders (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  ghana_card TEXT NOT NULL,
  location TEXT NOT NULL,
  region TEXT NOT NULL,
  occupation TEXT NOT NULL,
  date_of_birth DATE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'cancelled')),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Customer Purchases (tracking endpoint users)
CREATE TABLE IF NOT EXISTS public.customer_purchases (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  customer_phone TEXT NOT NULL,
  total_purchases INT DEFAULT 0,
  total_spent DECIMAL(12, 2) DEFAULT 0.00,
  first_purchase_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_purchase_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, customer_phone)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON public.wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_complaints_user_id ON public.complaints(user_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON public.complaints(status);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users(role);
CREATE INDEX IF NOT EXISTS idx_users_agent_expires_at ON public.users(agent_expires_at);

-- Row Level Security Policies

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payments"
  ON public.wallet_payments
  FOR SELECT
  USING (auth.uid() = user_id);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.afa_orders ENABLE ROW LEVEL SECURITY;

-- Users policies
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert their own profile" ON public.users
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Wallets policies
CREATE POLICY "Users can view own wallet" ON public.wallets
  FOR SELECT USING (auth.uid() = user_id);

-- Wallet transactions policies
CREATE POLICY "Users can view own transactions" ON public.wallet_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- Orders policies
CREATE POLICY "Users can view own orders" ON public.orders
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create orders" ON public.orders
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Notifications policies
CREATE POLICY "Users can view own notifications" ON public.notifications
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications" ON public.notifications
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own notifications" ON public.notifications
  FOR DELETE USING (auth.uid() = user_id);

-- Complaints policies
CREATE POLICY "Users can view own complaints" ON public.complaints
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create complaints" ON public.complaints
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Data packages policies (public read)
CREATE POLICY "Anyone can view packages" ON public.data_packages
  FOR SELECT USING (true);

-- Customer purchases policies
CREATE POLICY "Users can view own customer purchases" ON public.customer_purchases
  FOR SELECT USING (auth.uid() = user_id);

-- AFA orders policies
CREATE POLICY "Users can view own AFA orders" ON public.afa_orders
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create AFA orders" ON public.afa_orders
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Function to auto-create wallet on user creation
CREATE OR REPLACE FUNCTION public.handle_new_user_wallet()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.wallets (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for auto-creating wallet
DROP TRIGGER IF EXISTS on_user_created_wallet ON public.users;
CREATE TRIGGER on_user_created_wallet
  AFTER INSERT ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_wallet();

-- Insert default admin settings
INSERT INTO public.admin_settings (key, value) VALUES
  ('paystack_fee_percent', '1.95'),
  ('auto_fulfillment_enabled', 'true'),
  ('support_whatsapp', '""'),
  ('support_email', '"arhmsghltd@gmail.com"'),
  ('support_phone', '""'),
  ('announcement_enabled', 'false'),
  ('announcement_title', '""'),
  ('announcement_message', '""'),
  ('mtn_price_adjustment', '0'),
  ('telecel_price_adjustment', '0'),
  ('airteltigo_price_adjustment', '0')
ON CONFLICT (key) DO NOTHING;

-- Sample data packages
INSERT INTO public.data_packages (network, size, price, cost_price, description, sort_order) VALUES
  ('MTN', '1GB', 5.00, 4.00, '1GB data valid for 30 days', 1),
  ('MTN', '2GB', 10.00, 8.00, '2GB data valid for 30 days', 2),
  ('MTN', '5GB', 20.00, 16.00, '5GB data valid for 30 days', 3),
  ('MTN', '10GB', 35.00, 30.00, '10GB data valid for 30 days', 4),
  ('Telecel', '1GB', 5.50, 4.50, '1GB data valid for 30 days', 1),
  ('Telecel', '2GB', 10.50, 9.00, '2GB data valid for 30 days', 2),
  ('Telecel', '5GB', 22.00, 18.00, '5GB data valid for 30 days', 3),
  ('AT-iShare', '1GB', 5.00, 4.00, '1GB data valid for 30 days', 1),
  ('AT-iShare', '2GB', 10.00, 8.00, '2GB data valid for 30 days', 2),
  ('AT-BigTime', '5GB', 25.00, 20.00, '5GB BigTime data', 1),
  ('AT-BigTime', '10GB', 45.00, 36.00, '10GB BigTime data', 2)
ON CONFLICT DO NOTHING;

create table public.system_announcements (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  message text not null,
  is_active boolean default true,
  visible_on text default 'main_site' check (visible_on in ('main_site', 'storefronts', 'both')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.system_announcements enable row level security;

-- Policies
create policy "Public read access"
  on public.system_announcements for select
  using (true);

create policy "Admin full access"
  on public.system_announcements for all
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'admin'
    )
  );

