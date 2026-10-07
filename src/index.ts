import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { jwtVerify } from 'jose';
import postgres from 'postgres';

type Bindings = {
  HYPERDRIVE: { connectionString: string };
  R2_BUCKET: R2Bucket;
  SUPABASE_ORIGIN_URL: string;
  SUPABASE_JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// -----------------------------------------------------------------------------
// 1. OFFICIAL HONO CORS MIDDLEWARE (Handles preflight across all subpaths!)
// -----------------------------------------------------------------------------
app.use('*', cors({
  origin: (origin) => origin || '*',
  allowHeaders: ['authorization', 'apikey', 'content-type', 'prefer', 'x-client-info', 'x-supabase-api-version'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
  maxAge: 86400,
}));

// -----------------------------------------------------------------------------
// POSTGRES CONNECTION FACTORY (PARSING NUMERICS & PRESERVING WALL-CLOCK DATES)
// -----------------------------------------------------------------------------
function createDbClient(connectionString: string) {
  return postgres(connectionString, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
    connection: {
      timezone: 'Asia/Manila', // Synchronizes server queries to Philippine Standard Time (UTC+8)
    },
    types: {
      // 1. Convert PostgreSQL NUMERIC / DECIMAL (OID 1700) to JavaScript Numbers (Float)
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: any) => '' + x,
        parse: (x: any) => (x === null ? null : parseFloat(x)),
      },
      // 2. Convert PostgreSQL BIGINT (OID 20) to JavaScript Numbers (Int)
      int8: {
        to: 20,
        from: [20],
        serialize: (x: any) => '' + x,
        parse: (x: any) => (x === null ? null : parseInt(x, 10)),
      },
      // 3. PRESERVE DATE WITHOUT TIMEZONE (OID 1082) - Raw "YYYY-MM-DD"
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: any) => '' + x,
        parse: (x: any) => (x === null ? null : String(x)),
      },
      // 4. PRESERVE TIMESTAMP WITHOUT TIMEZONE (OID 1114) - Raw "YYYY-MM-DD HH:MM:SS"
      timestamp: {
        to: 1114,
        from: [1114],
        serialize: (x: any) => '' + x,
        parse: (x: any) => (x === null ? null : String(x)),
      },
    },
  });
}

// -----------------------------------------------------------------------------
// 2. 1-STEP R2 UPLOAD + AUTOMATIC DATABASE SAVE (/api/upload)
// -----------------------------------------------------------------------------
app.post('/api/upload', async (c) => {
  try {
    // A. Verify R2 Bucket Binding
    if (!c.env.R2_BUCKET) {
      console.error('[Upload Error]: R2_BUCKET binding is missing from wrangler configuration.');
      return c.json({ message: 'Server configuration error: R2 bucket not bound.', code: '500' }, 500);
    }

    // B. Authenticate via Supabase JWT
    const authHeader = c.req.header('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ message: 'Unauthorized: User session required.', code: '401' }, 401);
    }

    let userId: string;
    try {
      const token = authHeader.split(' ')[1];
      const secret = new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET);
      const { payload } = await jwtVerify(token, secret);
      userId = payload.sub as string;
      if (!userId) throw new Error('Missing sub');
    } catch (err: any) {
      return c.json({ message: 'Invalid token or session expired.', details: err.message, code: '401' }, 401);
    }

    // C. Parse Multipart Form Data
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch (err) {
      return c.json({ message: 'Invalid form data payload.', code: '400' }, 400);
    }

    const file = formData.get('file') as File | null;
    const docType = (
      (formData.get('docType') as string) ||
      (formData.get('formType') as string) ||
      (formData.get('type') as string) ||
      'documents'
    ).trim();

    const productId = formData.get('product_id') as string | null;

    if (!file) {
      return c.json({ message: 'No file provided in request.', code: '400' }, 400);
    }

    // D. Validation: Size limit (max 15MB) & Allowed mime types
    if (file.size > 15 * 1024 * 1024) {
      return c.json({ message: 'File exceeds 15MB size limit.', code: '400' }, 400);
    }

    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type.toLowerCase())) {
      return c.json({ message: 'Only PDF, PNG, JPG, and WEBP files are allowed.', code: '400' }, 400);
    }

    // E. Save to Cloudflare R2 ('ceintelly' bucket)
    const extension = file.name.split('.').pop() || 'bin';
    const fileKey = `${docType}/${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;

    const arrayBuffer = await file.arrayBuffer();
    await c.env.R2_BUCKET.put(fileKey, arrayBuffer, {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        uploadedBy: userId,
        originalName: file.name,
        docType: docType,
      },
    });

    const workerUrl = new URL(c.req.url).origin;
    const publicUrl = `${workerUrl}/files/${fileKey}`;

    // F. AUTOMATIC DATABASE SAVE VIA HYPERDRIVE
    const sql = createDbClient(c.env.HYPERDRIVE.connectionString);
    let savedEntity = 'none';

    try {
      if (docType === '2303') {
        await sql`
          INSERT INTO public.pos2_business_settings (user_id, bir_2303_url, bir_2303_status, updated_at)
          VALUES (${userId}, ${publicUrl}, 'pending', NOW())
          ON CONFLICT (user_id) DO UPDATE SET 
            bir_2303_url = ${publicUrl},
            bir_2303_status = 'pending',
            updated_at = NOW();
        `;
        savedEntity = 'business_settings_2303';

      } else if (docType === '2307') {
        await sql`
          INSERT INTO public.pos2_business_settings (user_id, bir_2307_url, bir_2307_status, updated_at)
          VALUES (${userId}, ${publicUrl}, 'pending', NOW())
          ON CONFLICT (user_id) DO UPDATE SET 
            bir_2307_url = ${publicUrl},
            bir_2307_status = 'pending',
            updated_at = NOW();
        `;
        savedEntity = 'business_settings_2307';

      } else if ((docType === 'product_image' || docType === 'products') && productId) {
        await sql`
          UPDATE public.pos2_products
          SET image_url = ${publicUrl}, updated_at = NOW()
          WHERE id = ${Number(productId)} AND user_id = ${userId};
        `;
        savedEntity = 'product_image';
      }

      // Bump tenant cache version automatically
      const scope = docType.includes('230') ? 'settings' : 'catalog';
      await sql`
        INSERT INTO public.tenant_cache_versions (user_id, subscription_id, scope, version, updated_at)
        VALUES (${userId}, 1, ${scope}, EXTRACT(EPOCH FROM NOW())::BIGINT, NOW())
        ON CONFLICT (user_id, subscription_id, scope) 
        DO UPDATE SET 
          version = EXTRACT(EPOCH FROM NOW())::BIGINT,
          updated_at = NOW();
      `;
    } catch (dbErr: any) {
      console.error('[Upload DB Auto-Save Error]:', dbErr);
    } finally {
      await sql.end();
    }

    return c.json({
      success: true,
      message: 'File uploaded to R2 and automatically saved to your database!',
      file_key: fileKey,
      url: publicUrl,
      saved_entity: savedEntity,
    });
  } catch (err: any) {
    console.error('[Upload General Error]:', err);
    return c.json({ message: err.message || 'File upload failed.', code: '500' }, 500);
  }
});

// -----------------------------------------------------------------------------
// 3. SERVE FILES DIRECTLY FROM CLOUDFLARE R2 (/files/*)
// -----------------------------------------------------------------------------
app.get('/files/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const object = await c.env.R2_BUCKET.get(key);

  if (!object) {
    return c.text('File not found in R2.', 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(object.body, { headers });
});

// -----------------------------------------------------------------------------
// FUNCTION WHITELISTS
// -----------------------------------------------------------------------------
// A. Public / Unauthenticated RPCs (Called without a logged-in user session)
const PUBLIC_ANON_FUNCTIONS = new Set([
  'can_request_password_reset',
  'can_submit_new_password',
  'c_verify_password_reset_rate_limit',
  'c_get_marketplace_products',
]);

// B. Staff/Security procedures that don't start with pos2_ or c_
const EXTRA_AUTH_FUNCTIONS = new Set([
  'validate_pos_account_password',
  'validate_pos_staff_user',
  'request_admin_persona_reset',
  'confirm_admin_persona_reset',
  'pos_can_manage',
  'pos_can_inventory',
  'pos_can_view_reports',
]);

// C. Read-only procedures utilizing Hyperdrive Edge Caching
// NOTE: pos2_get_terminal_state, pos2_get_rentable_assets, and c_get_my_notifications
// are strictly EXCLUDED so counters and room occupancy are always live!
const CACHEABLE_READ_PROCEDURES = new Set([
  // Products, Catalog, Services & Inventory Lookups
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

  // Installment Payment Receipts
  'pos2_get_installment_payment_receipt',
  'pos2_get_installment_payments_by_order',

  // Market Website Reads
  'c_get_business_settings',
  'c_get_marketplace_products',
  'c_get_subscription_invoice',
  'c_get_my_subscription_invoices',
]);

// Determine tenant cache scope for invalidation matching
function getProcedureScope(procName: string): string {
  if (
    procName.includes('product') || 
    procName.includes('inventory') || 
    procName.includes('stock') || 
    procName.includes('service')
  ) {
    return 'catalog';
  }
  if (
    procName.includes('customer') || 
    procName.includes('debt') || 
    procName.includes('installment')
  ) {
    return 'customers';
  }
  if (procName.includes('promo')) {
    return 'promotions';
  }
  if (
    procName.includes('business_settings') || 
    procName.includes('terminal') || 
    procName.includes('staff') ||
    procName.includes('asset') ||
    procName.includes('rent')
  ) {
    return 'settings';
  }
  if (
    procName.includes('report') ||
    procName.includes('history') ||
    procName.includes('journal') ||
    procName.includes('pnl') ||
    procName.includes('ledger') ||
    procName.includes('sales_book') ||
    procName.includes('audit')
  ) {
    return 'reports';
  }
  if (
    procName.includes('marketplace') || 
    procName.includes('notification') || 
    procName.includes('subscription')
  ) {
    return 'marketplace';
  }
  return 'general';
}

// -----------------------------------------------------------------------------
// 4. RPC INTERCEPTOR (HYPERDRIVE CONNECTION POOL)
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

  // 1. Resolve User ID (Authenticated vs Anonymous calls)
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

  // 2. Parse arguments safely
  let args: Record<string, any> = {};
  try {
    const rawBody = await c.req.text();
    if (rawBody && rawBody.trim() !== '') {
      args = JSON.parse(rawBody);
    }
  } catch (e) {
    return c.json({ message: 'Malformed JSON payload in RPC request.', code: 'PGRST100' }, 400);
  }

  // 3. Connect to PostgreSQL via Hyperdrive with custom type parsing
  const sql = createDbClient(c.env.HYPERDRIVE.connectionString);

  const isCacheable = CACHEABLE_READ_PROCEDURES.has(functionName);
  const argKeys = Object.keys(args);

  // Smart Type-Aware Argument Sanitizer:
  // - Preserves native PostgreSQL arrays (bigint[], text[] like p_eligible_product_ids)
  // - Serializes JSONB payloads (p_cart_items, p_payments, p_items_to_debt) cleanly
  // - Handles B2B strings and numbers without corruption
  const argValues = Object.entries(args).map(([key, val]) => {
    // A. Native PostgreSQL array parameters
    if (
      key.includes('eligible_product_ids') || 
      key.endsWith('_array') || 
      (key.endsWith('_ids') && Array.isArray(val))
    ) {
      if (Array.isArray(val)) {
        return val; // Native JS array -> postgres.js sends valid Postgres array syntax: {}
      }
      if (val === null || val === undefined || val === '' || val === '[]') {
        return [];
      }
      return val;
    }

    // B. If it's already a valid JSON string (e.g. "[{...}]"), keep it as is
    if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
      try {
        JSON.parse(val);
        return val;
      } catch {
        return val;
      }
    }

    // C. If it's a JSONB array of objects or an object, serialize as a JSON string
    if (val !== null && typeof val === 'object') {
      if (Array.isArray(val) && (val.length === 0 || typeof val[0] !== 'object')) {
        return val; // Array of primitives
      }
      return JSON.stringify(val);
    }

    return val;
  });

  try {
    if (isCacheable && userId) {
      // -----------------------------------------------------------------------
      // CACHEABLE READ PIPELINE (ATOMIC LATERAL WITH FUNCTION ALIAS)
      // -----------------------------------------------------------------------
      const scope = getProcedureScope(functionName);
      const subId = args['p_subscription_id'] ? Number(args['p_subscription_id']) : 1;

      const verRows = await sql`
        SELECT version FROM public.tenant_cache_versions
        WHERE user_id = ${userId} AND subscription_id = ${subId} AND scope = ${scope}
        LIMIT 1;
      `;
      const currentVersion = verRows.length > 0 ? verRows[0].version : 1;

      // ATOMIC QUERY: Binds user_id ($1) and aliases the table with the function name
      let queryText: string;
      let queryParams: any[];

      if (argKeys.length === 0) {
        queryText = `
          /* tenant:${userId}:${scope}:v${currentVersion} */
          SELECT "${functionName}".*
          FROM (SELECT set_config('request.jwt.claim.sub', $1, true)) AS _auth
          CROSS JOIN LATERAL public."${functionName}"() AS "${functionName}";
        `;
        queryParams = [userId];
      } else {
        const formattedParams = argKeys.map((k, i) => `"${k}" => $${i + 2}`).join(', ');
        queryText = `
          /* tenant:${userId}:${scope}:v${currentVersion} */
          SELECT "${functionName}".*
          FROM (SELECT set_config('request.jwt.claim.sub', $1, true)) AS _auth
          CROSS JOIN LATERAL public."${functionName}"(${formattedParams}) AS "${functionName}";
        `;
        queryParams = [userId, ...argValues];
      }

      const result = await sql.unsafe(queryText, queryParams);
      return c.json(formatPostgrestResponse(result, functionName));

    } else {
      // -----------------------------------------------------------------------
      // DIRECT TRANSACTIONAL PIPELINE (Sales, Voids, Rentals, Mutations)
      // Strict BEGIN ... COMMIT ensures Hyperdrive bypasses edge cache
      // -----------------------------------------------------------------------
      const result = await sql.begin(async (tx) => {
        if (userId) {
          await tx`SELECT set_config('request.jwt.claim.sub', ${userId}, true);`;
          await tx`SET LOCAL role = 'authenticated';`;
        } else {
          await tx`SET LOCAL role = 'anon';`;
        }

        if (argKeys.length === 0) {
          return await tx.unsafe(`SELECT * FROM public."${functionName}"();`);
        } else {
          const formattedParams = argKeys.map((k, i) => `"${k}" => $${i + 1}`).join(', ');
          return await tx.unsafe(
            `SELECT * FROM public."${functionName}"(${formattedParams});`,
            argValues
          );
        }
      });

      return c.json(formatPostgrestResponse(result, functionName));
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
// 5. REVERSE PROXY FOR SUPABASE AUTH & STORAGE
// -----------------------------------------------------------------------------
app.all('*', async (c) => {
  return proxyToSupabase(c);
});

async function proxyToSupabase(c: any) {
  try {
    const originUrl = new URL(c.req.url);
    const targetUrl = new URL(c.env.SUPABASE_ORIGIN_URL);

    targetUrl.pathname = originUrl.pathname;
    targetUrl.search = originUrl.search;

    const reqHeaders = new Headers();
    for (const [key, value] of c.req.raw.headers.entries()) {
      const lower = key.toLowerCase();
      if (!['host', 'connection', 'keep-alive', 'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'x-real-ip', 'content-length'].includes(lower)) {
        reqHeaders.set(key, value);
      }
    }

    const isBodyAllowed = !['GET', 'HEAD'].includes(c.req.method);
    const bodyData = isBodyAllowed ? await c.req.raw.arrayBuffer() : undefined;

    const response = await fetch(targetUrl.toString(), {
      method: c.req.method,
      headers: reqHeaders,
      body: bodyData,
      redirect: 'follow',
    });

    const resHeaders = new Headers(response.headers);
    resHeaders.delete('content-encoding');
    resHeaders.delete('content-length');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders,
    });
  } catch (err: any) {
    return c.json({ error: err.message || 'Proxy error' }, 502);
  }
}

// -----------------------------------------------------------------------------
// POSTGREST-IDENTICAL RESPONSE SHAPER
// -----------------------------------------------------------------------------
function formatPostgrestResponse(rows: any[], functionName: string) {
  if (!rows || rows.length === 0) return [];

  const keys = Object.keys(rows[0]);

  // 1. If PostgreSQL named the column after the function itself
  // (Scalars: boolean, text, or jsonb object)
  if (rows.length === 1 && keys.length === 1 && keys[0].toLowerCase() === functionName.toLowerCase()) {
    return rows[0][keys[0]];
  }

  // 2. If the function returned a single jsonb object under any single column
  if (
    rows.length === 1 &&
    keys.length === 1 &&
    typeof rows[0][keys[0]] === 'object' &&
    rows[0][keys[0]] !== null &&
    !Array.isArray(rows[0][keys[0]]) &&
    (keys[0].startsWith('pos2_') || keys[0].startsWith('c_') || keys[0].startsWith('pos_') || keys[0].startsWith('can_'))
  ) {
    return rows[0][keys[0]];
  }

  // 3. For functions defined as RETURNS TABLE(...), return the full array of row objects
  return rows;
}

export default app;
