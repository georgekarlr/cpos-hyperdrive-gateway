import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { jwtVerify } from 'jose';
import postgres from 'postgres';

type Bindings = {
  HYPERDRIVE: { connectionString: string };
  SUPABASE_ORIGIN_URL: string;
  SUPABASE_JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS for web apps (Market, Admin, POS)
app.use('*', cors({
  origin: '*',
  allowHeaders: ['authorization', 'apikey', 'content-type', 'prefer', 'x-client-info'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['content-range', 'content-length'],
  maxAge: 86400,
}));

// 1. Unauthenticated/Public RPCs (Called without a logged-in user session)
const PUBLIC_ANON_FUNCTIONS = new Set([
  'can_request_password_reset',
  'can_submit_new_password',
  'c_verify_password_reset_rate_limit',
  'c_get_marketplace_products',
]);

// 2. Extra Auth/Persona procedures that don't start with pos2_ or c_
const EXTRA_AUTH_FUNCTIONS = new Set([
  'validate_pos_account_password',
  'validate_pos_staff_user',
  'request_admin_persona_reset',
  'confirm_admin_persona_reset',
  'pos_can_manage',
  'pos_can_inventory',
  'pos_can_view_reports',
]);

// 3. Cacheable read procedures (Hyperdrive Edge Cache)
const CACHEABLE_READ_PROCEDURES = new Set([
  // Products, Catalog & Inventory Lookups
  'pos2_get_product_details',
  'pos2_get_all_products',
  'pos2_get_product_activity_by_id',
  'pos2_get_product_activity_history',
  'pos2_report_low_stock_products',
  'pos2_report_inventory_valuation',

  // Promotions Lookups
  'pos2_get_promotions',
  'pos2_get_promo_product_prices',

  // Customers & Debt Lookups
  'pos2_get_customers',
  'pos2_get_customers_simple',
  'pos2_search_customers',
  'pos2_get_customer_by_id',
  'pos2_get_customer_debt_details',
  'pos2_get_customer_financial_summary',
  'pos2_get_customer_installments',
  'pos2_get_all_installment_contracts',

  // Settings & Terminals Lookups
  'pos2_get_business_settings',
  'pos2_get_terminals',
  'pos2_get_client_terminal_settings',
  'pos2_get_merchant_pos_subscriptions',
  'pos2_get_staff_accounts',

  // Historical Sales, Audit & Statutory Books
  'pos2_get_sales_history',
  'pos2_get_sale_details_by_id',
  'pos2_get_refundable_items',
  'pos2_get_refund_details',
  'pos2_report_bir_sales_book',
  'pos2_report_sc_pwd_book',
  'pos2_report_senior_citizen_book',
  'pos2_report_pwd_book',
  'pos2_report_solo_parent_book',
  'pos2_report_student_book',
  'pos2_report_national_athlete_book',
  'pos2_report_promotions_book',
  'pos2_report_all_discounts_summary',
  'pos2_report_voids_and_refunds',
  'pos2_report_sales_over_time',
  'pos2_report_sales_by_staff',
  'pos2_report_best_selling_products',
  'pos2_get_bir_tax_ledger',
  'pos2_get_monthly_tax_preparation',
  'pos2_get_ar_aging_report',
  'pos2_get_pnl_statement',
  'pos2_get_z_readings_history',
  'pos2_get_e_journal',
  'pos2_get_dashboard_data',
  'pos2_get_system_audit_trail',

  // Market Website Reads
  'c_get_marketplace_products',
  'c_get_subscription_invoice',
  'c_get_my_subscription_invoices',
]);

// Determine tenant cache scope
function getProcedureScope(procName: string): string {
  if (procName.includes('product') || procName.includes('inventory') || procName.includes('stock') || procName.includes('marketplace')) return 'catalog';
  if (procName.includes('customer') || procName.includes('debt') || procName.includes('installment')) return 'customers';
  if (procName.includes('promo')) return 'promotions';
  if (procName.includes('business_settings') || procName.includes('terminal') || procName.includes('staff')) return 'settings';
  if (procName.includes('report') || procName.includes('history') || procName.includes('journal') || procName.includes('pnl') || procName.includes('ledger') || procName.includes('invoice')) return 'reports';
  return 'general';
}

// -----------------------------------------------------------------------------
// POSTGREST RPC INTERCEPTOR: /rest/v1/rpc/:functionName
// -----------------------------------------------------------------------------
app.post('/rest/v1/rpc/:functionName', async (c) => {
  const functionName = c.req.param('functionName');

  const isTargetFunction = 
    functionName.startsWith('pos2_') || 
    functionName.startsWith('c_') || 
    functionName.startsWith('can_') || 
    EXTRA_AUTH_FUNCTIONS.has(functionName);

  if (!isTargetFunction) {
    return proxyToSupabase(c);
  }

  // 1. Resolve User ID (Handle Authenticated vs Anonymous Calls)
  const isPublicCall = PUBLIC_ANON_FUNCTIONS.has(functionName);
  let userId: string | null = null;
  const authHeader = c.req.header('authorization');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const secret = new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET);
      const { payload } = await jwtVerify(token, secret);
      userId = (payload.sub as string) || null;
    } catch (err: any) {
      if (!isPublicCall) {
        return c.json({ message: 'Unauthorized: Invalid Supabase JWT.', details: err.message, code: '401' }, 401);
      }
    }
  } else if (!isPublicCall) {
    return c.json({ message: 'Missing or invalid Authorization header.', code: '401' }, 401);
  }

  // 2. Parse JSON Body
  let args: Record<string, any> = {};
  try {
    const rawBody = await c.req.text();
    if (rawBody && rawBody.trim() !== '') {
      args = JSON.parse(rawBody);
    }
  } catch (e) {
    return c.json({ message: 'Malformed JSON payload in RPC request.', code: 'PGRST100' }, 400);
  }

  // 3. Connect to PostgreSQL via Hyperdrive
  const sql = postgres(c.env.HYPERDRIVE.connectionString, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
  });

  const isCacheable = CACHEABLE_READ_PROCEDURES.has(functionName);

  try {
    if (isCacheable && userId) {
      // -----------------------------------------------------------------------
      // CACHEABLE READ PIPELINE (Edge Caching + Version Tagging)
      // -----------------------------------------------------------------------
      const scope = getProcedureScope(functionName);
      const subId = args['p_subscription_id'] ? Number(args['p_subscription_id']) : 1;

      const verRows = await sql`
        SELECT version FROM public.tenant_cache_versions
        WHERE user_id = ${userId} AND subscription_id = ${subId} AND scope = ${scope}
        LIMIT 1;
      `;
      const currentVersion = verRows.length > 0 ? verRows[0].version : 1;

      const argKeys = Object.keys(args);
      const formattedParams = argKeys.map((k, i) => `${k} := $${i + 2}`).join(', ');
      const queryText = `
        /* tenant:${userId}:${scope}:v${currentVersion} */
        SELECT * FROM public.${functionName}(${formattedParams});
      `;

      await sql`SELECT set_config('request.jwt.claim.sub', ${userId}, false);`;
      const result = await sql.unsafe(queryText, [null, ...Object.values(args)]);
      return c.json(formatPostgrestResponse(result));

    } else {
      // -----------------------------------------------------------------------
      // DIRECT TRANSACTIONAL PIPELINE (Sales, Voids, Admin Actions, Reset Passwords)
      // Strict BEGIN ... COMMIT ensures Hyperdrive bypasses edge cache.
      // -----------------------------------------------------------------------
      const result = await sql.begin(async (tx) => {
        if (userId) {
          await tx`SELECT set_config('request.jwt.claim.sub', ${userId}, true);`;
          await tx`SET LOCAL role = 'authenticated';`;
        } else {
          await tx`SET LOCAL role = 'anon';`;
        }

        const argKeys = Object.keys(args);
        if (argKeys.length === 0) {
          return await tx.unsafe(`SELECT * FROM public.${functionName}();`);
        }

        const formattedParams = argKeys.map((k, i) => `${k} := $${i + 1}`).join(', ');
        return await tx.unsafe(
          `SELECT * FROM public.${functionName}(${formattedParams});`,
          Object.values(args)
        );
      });

      return c.json(formatPostgrestResponse(result));
    }
  } catch (err: any) {
    return c.json({
      message: err.message || 'Database error occurred.',
      code: err.code || 'P0001',
      details: err.detail || null,
      hint: err.hint || null,
    }, 400);
  } finally {
    await sql.end();
  }
});

// -----------------------------------------------------------------------------
// REVERSE PROXY FALLBACK (Supabase Auth, Storage, Edge Functions)
// -----------------------------------------------------------------------------
app.all('*', async (c) => {
  return proxyToSupabase(c);
});

async function proxyToSupabase(c: any) {
  const originUrl = new URL(c.req.url);
  const targetUrl = new URL(c.env.SUPABASE_ORIGIN_URL);

  targetUrl.pathname = originUrl.pathname;
  targetUrl.search = originUrl.search;

  const headers = new Headers(c.req.raw.headers);
  headers.set('host', targetUrl.hostname);

  const response = await fetch(targetUrl.toString(), {
    method: c.req.method,
    headers: headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
    redirect: 'follow',
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function formatPostgrestResponse(rows: any[]) {
  if (!rows || rows.length === 0) return [];

  const keys = Object.keys(rows[0]);
  if (
    rows.length === 1 && 
    keys.length === 1 && 
    (typeof rows[0][keys[0]] === 'object' || keys[0].startsWith('pos2_') || keys[0].startsWith('c_') || keys[0].startsWith('can_'))
  ) {
    return rows[0][keys[0]];
  }

  return rows;
}

export default app;