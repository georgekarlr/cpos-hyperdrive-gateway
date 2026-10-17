import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { jwtVerify } from 'jose';
import postgres from 'postgres';
import { 
  formatBirEisPayload, 
  signEisPayload, 
  getBirAuthToken, 
  transmitInvoiceToBir, 
  transmitBatchToBir,
  inquireInvoiceStatus,
  EisCredentials
} from './eis';
import { sweepAndTransmitAllActiveEisMerchants } from './eis-sweep';

type Bindings = {
  HYPERDRIVE: { connectionString: string };
  R2_BUCKET: R2Bucket;
  SUPABASE_ORIGIN_URL: string;
  SUPABASE_JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// -----------------------------------------------------------------------------
// 1. OFFICIAL HONO CORS MIDDLEWARE (Handles preflight across all subpaths)
// -----------------------------------------------------------------------------
app.use('*', cors({
  origin: (origin) => origin || '*',
  allowHeaders: [
    'authorization', 
    'apikey', 
    'content-type', 
    'content-profile', 
    'accept-profile', 
    'prefer', 
    'x-client-info', 
    'x-supabase-api-version'
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
  maxAge: 86400,
}));

// -----------------------------------------------------------------------------
// POSTGRES CONNECTION FACTORY (PARSING NUMERICS & PRESERVING WALL-CLOCK DATES)
// -----------------------------------------------------------------------------
export function createDbClient(connectionString: string) {
  return postgres(connectionString, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
    connection: {
      timezone: 'Asia/Manila', // Synchronizes server queries to Philippine Standard Time (UTC+8)
    },
    types: {
      // 1. Convert PostgreSQL NUMERIC / DECIMAL (OID 1700) to JavaScript Float
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: any) => '' + x,
        parse: (x: any) => (x === null ? null : parseFloat(x)),
      },
      // 2. Convert PostgreSQL BIGINT (OID 20) to JavaScript Numbers
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
// 2. 1-STEP R2 UPLOAD + AUTO-SAVE + AUTO-CLEANUP PREVIOUS FILES (/api/upload)
// -----------------------------------------------------------------------------
app.post('/api/upload', async (c) => {
  try {
    if (!c.env.R2_BUCKET) {
      return c.json({ message: 'Server configuration error: R2 bucket not bound.', code: '500' }, 500);
    }

    // Authenticate via Supabase JWT
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
    const orderId = (formData.get('order_id') as string | null) || (formData.get('invoice_id') as string | null);

    if (!file) {
      return c.json({ message: 'No file provided in request.', code: '400' }, 400);
    }

    if (file.size > 15 * 1024 * 1024) {
      return c.json({ message: 'File exceeds 15MB size limit.', code: '400' }, 400);
    }

    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type.toLowerCase())) {
      return c.json({ message: 'Only PDF, PNG, JPG, and WEBP files are allowed.', code: '400' }, 400);
    }

    // Generate Clean File Key & Cleanup Prefix
    const extension = file.name.split('.').pop() || 'bin';
    let fileKey: string;
    let cleanupPrefix: string | null = null;

    if (orderId && (docType === 'order_2307' || docType === '2307' || docType === 'cwt')) {
      fileKey = `orders/${userId}/2307-order-${orderId}-${Date.now()}.${extension}`;
      cleanupPrefix = `orders/${userId}/2307-order-${orderId}-`;
    } else if (docType === '2303' || docType === '2307') {
      fileKey = `${docType}/${userId}/${Date.now()}.${extension}`;
      cleanupPrefix = `${docType}/${userId}/`;
    } else if (productId && (docType === 'product_image' || docType === 'products')) {
      fileKey = `products/${userId}/prod-${productId}-${Date.now()}.${extension}`;
      cleanupPrefix = `products/${userId}/prod-${productId}-`;
    } else if (docType === 'feedback' || docType === 'ticket') {
      fileKey = `feedback/${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
    } else {
      fileKey = `${docType}/${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
    }

    // Save New File to R2
    const arrayBuffer = await file.arrayBuffer();
    await c.env.R2_BUCKET.put(fileKey, arrayBuffer, {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        uploadedBy: userId,
        originalName: file.name,
        docType: docType,
        orderId: orderId || '',
        productId: productId || '',
      },
    });

    // Delete superseded files in background
    if (cleanupPrefix) {
      try {
        const existingObjects = await c.env.R2_BUCKET.list({ prefix: cleanupPrefix });
        for (const obj of existingObjects.objects) {
          if (obj.key !== fileKey) {
            await c.env.R2_BUCKET.delete(obj.key);
          }
        }
      } catch (cleanupErr) {
        console.warn('[R2 Auto-Cleanup Warning]:', cleanupErr);
      }
    }

    const workerUrl = new URL(c.req.url).origin;
    const publicUrl = `${workerUrl}/files/${fileKey}`;

    // Auto-Save into Database via Hyperdrive
    const sql = createDbClient(c.env.HYPERDRIVE.connectionString);
    let savedEntity = 'none';

    try {
      if (orderId && (docType === 'order_2307' || docType === '2307' || docType === 'cwt')) {
        await sql`
          UPDATE public.pos2_orders
          SET 
            cwt_certificate_url = ${publicUrl},
            is_cwt_verified = FALSE,
            cwt_verified_at = NULL,
            cwt_verified_by = NULL
          WHERE id = ${Number(orderId)};
        `;
        savedEntity = 'order_2307_certificate';

      } else if (docType === '2303') {
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

      // Bump tenant cache version
      const scope = (docType.includes('230') || orderId) ? 'settings' : (docType === 'feedback' ? 'marketplace' : 'catalog');
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
      message: 'File uploaded, replaced previous file, and saved to database!',
      file_key: fileKey,
      url: publicUrl,
      saved_entity: savedEntity,
      order_id: orderId || null,
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
// 4. BIR EIS API TRANSMISSION ENDPOINTS
// -----------------------------------------------------------------------------

// A. TRANSMIT SINGLE INVOICE (For Certification Testing on eis-cert.bir.gov.ph)
app.post('/api/eis/transmit-order/:orderId', async (c) => {
  const orderId = Number(c.req.param('orderId'));
  if (!orderId) {
    return c.json({ success: false, message: 'Valid Order ID required.' }, 400);
  }

  const authHeader = c.req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, message: 'Unauthorized: User session required.' }, 401);
  }

  let userId: string;
  try {
    const token = authHeader.split(' ')[1];
    const secret = new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    userId = payload.sub as string;
  } catch (err: any) {
    return c.json({ success: false, message: 'Invalid token.', details: err.message }, 401);
  }

  const sql = createDbClient(c.env.HYPERDRIVE.connectionString);

  try {
    const [eisSettings] = await sql`
      SELECT * FROM public.pos2_eis_settings 
      WHERE user_id = ${userId} AND is_active = TRUE 
      LIMIT 1;
    `;

    if (!eisSettings || !eisSettings.client_id || !eisSettings.private_signing_key) {
      return c.json({
        success: false,
        message: 'BIR EIS credentials not configured or inactive. Please configure Client ID and Private Key in EIS Settings.',
      }, 400);
    }

    const [order] = await sql`
      SELECT o.*, t.terminal_name, t.min, t.ptu_number 
      FROM public.pos2_orders o
      LEFT JOIN public.pos2_terminals t ON o.terminal_id = t.id
      WHERE o.id = ${orderId} AND o.user_id = ${userId};
    `;

    if (!order) {
      return c.json({ success: false, message: 'Order not found or access denied.' }, 404);
    }

    if (order.eis_status === 'transmitted') {
      return c.json({
        success: true,
        message: 'This invoice has already been successfully transmitted to the BIR EIS.',
        ackId: order.eis_ack_id,
        transmitted_at: order.eis_transmitted_at,
      });
    }

    const items = await sql`
      SELECT oi.*, p.name AS product_name, COALESCE(p.item_type, 'goods') AS item_type
      FROM public.pos2_order_items oi
      JOIN public.pos2_products p ON oi.product_id = p.id
      WHERE oi.order_id = ${orderId};
    `;

    const [bizSettings] = await sql`
      SELECT * FROM public.pos2_business_settings WHERE user_id = ${userId} LIMIT 1;
    `;

    const payload = formatBirEisPayload(order, items, bizSettings);
    const signedJws = await signEisPayload(payload, eisSettings.private_signing_key);

    const creds: EisCredentials = {
      clientId: eisSettings.client_id,
      clientSecret: eisSettings.client_secret,
      privateSigningKey: eisSettings.private_signing_key,
      pttNumber: eisSettings.ptt_number,
      environment: eisSettings.environment as 'sandbox' | 'production',
    };

    const authToken = await getBirAuthToken(creds);
    const transmissionResult = await transmitInvoiceToBir(signedJws, authToken, creds);

    await sql`
      UPDATE public.pos2_orders
      SET 
        eis_status = 'transmitted',
        eis_ack_id = ${transmissionResult.ackId},
        eis_transmitted_at = NOW()
      WHERE id = ${orderId};
    `;

    return c.json({
      success: true,
      message: 'Invoice successfully signed, transmitted, and acknowledged by BIR EIS!',
      order_id: orderId,
      invoice_number: order.invoice_number,
      ackId: transmissionResult.ackId,
      status: transmissionResult.status,
    });
  } catch (err: any) {
    console.error('[BIR EIS Single Transmission Error]:', err);
    return c.json({
      success: false,
      message: 'BIR EIS Transmission Failed.',
      details: err.message || err,
    }, 500);
  } finally {
    await sql.end();
  }
});

// B. TRANSMIT BATCH (Up to 100 Pending Invoices in 1 Single BIR API Call)
app.post('/api/eis/transmit-batch', async (c) => {
  const authHeader = c.req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, message: 'Unauthorized: User session required.' }, 401);
  }

  let userId: string;
  try {
    const token = authHeader.split(' ')[1];
    const secret = new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    userId = payload.sub as string;
  } catch (err: any) {
    return c.json({ success: false, message: 'Invalid token.', details: err.message }, 401);
  }

  const sql = createDbClient(c.env.HYPERDRIVE.connectionString);

  try {
    const [eisSettings] = await sql`
      SELECT * FROM public.pos2_eis_settings 
      WHERE user_id = ${userId} AND is_active = TRUE 
      LIMIT 1;
    `;

    if (!eisSettings || !eisSettings.client_id || !eisSettings.private_signing_key) {
      return c.json({
        success: false,
        message: 'BIR EIS credentials not configured or inactive.',
      }, 400);
    }

    const [bizSettings] = await sql`
      SELECT * FROM public.pos2_business_settings WHERE user_id = ${userId} LIMIT 1;
    `;

    const pendingOrders = await sql`
      SELECT o.*, t.terminal_name, t.min, t.ptu_number 
      FROM public.pos2_orders o
      LEFT JOIN public.pos2_terminals t ON o.terminal_id = t.id
      WHERE o.user_id = ${userId}
        AND o.eis_status = 'pending'
      ORDER BY COALESCE(o.occurred_at, o.created_at) ASC
      LIMIT 100;
    `;

    if (pendingOrders.length === 0) {
      return c.json({
        success: true,
        message: 'No pending invoices to transmit. All sales are up to date.',
        transmitted_count: 0,
      });
    }

    const orderIds = pendingOrders.map((o) => o.id);

    const allItems = await sql`
      SELECT oi.*, p.name AS product_name, COALESCE(p.item_type, 'goods') AS item_type
      FROM public.pos2_order_items oi
      JOIN public.pos2_products p ON oi.product_id = p.id
      WHERE oi.order_id = ANY(${orderIds});
    `;

    const itemsByOrder: Record<number, any[]> = {};
    for (const item of allItems) {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push(item);
    }

    // Sign all invoices in parallel using Web Crypto
    const signedJwsList: string[] = await Promise.all(
      pendingOrders.map(async (order) => {
        const orderItems = itemsByOrder[order.id] || [];
        const payload = formatBirEisPayload(order, orderItems, bizSettings);
        return await signEisPayload(payload, eisSettings.private_signing_key);
      })
    );

    const creds: EisCredentials = {
      clientId: eisSettings.client_id,
      clientSecret: eisSettings.client_secret,
      privateSigningKey: eisSettings.private_signing_key,
      pttNumber: eisSettings.ptt_number,
      environment: eisSettings.environment as 'sandbox' | 'production',
    };

    const authToken = await getBirAuthToken(creds);
    const batchResponse = await transmitBatchToBir(signedJwsList, authToken, creds);

    const globalAckId = batchResponse.batchAckId || batchResponse.ackId || `BATCH-ACK-${Date.now()}`;

    await sql`
      UPDATE public.pos2_orders
      SET 
        eis_status = 'transmitted',
        eis_ack_id = ${globalAckId},
        eis_transmitted_at = NOW()
      WHERE id = ANY(${orderIds});
    `;

    return c.json({
      success: true,
      message: `Successfully transmitted batch of ${pendingOrders.length} invoice(s) to BIR EIS!`,
      batch_ack_id: globalAckId,
      invoices_transmitted: pendingOrders.length,
      invoice_numbers: pendingOrders.map((o) => o.invoice_number),
    });
  } catch (err: any) {
    console.error('[BIR EIS Batch Transmission Error]:', err);
    return c.json({
      success: false,
      message: 'BIR EIS Batch Transmission Failed.',
      details: err.message || err,
    }, 500);
  } finally {
    await sql.end();
  }
});

// C. INQUIRE TRANSMISSION STATUS FROM BIR VIA ACKID
app.get('/api/eis/status/:ackId', async (c) => {
  const ackId = c.req.param('ackId');
  const authHeader = c.req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, message: 'Unauthorized.' }, 401);
  }

  let userId: string;
  try {
    const token = authHeader.split(' ')[1];
    const secret = new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    userId = payload.sub as string;
  } catch (err: any) {
    return c.json({ success: false, message: 'Invalid token.' }, 401);
  }

  const sql = createDbClient(c.env.HYPERDRIVE.connectionString);

  try {
    const [eisSettings] = await sql`
      SELECT * FROM public.pos2_eis_settings 
      WHERE user_id = ${userId} AND is_active = TRUE 
      LIMIT 1;
    `;

    if (!eisSettings) {
      return c.json({ success: false, message: 'EIS settings not configured.' }, 400);
    }

    const creds: EisCredentials = {
      clientId: eisSettings.client_id,
      clientSecret: eisSettings.client_secret,
      privateSigningKey: eisSettings.private_signing_key,
      pttNumber: eisSettings.ptt_number,
      environment: eisSettings.environment as 'sandbox' | 'production',
    };

    const authToken = await getBirAuthToken(creds);
    const statusResult = await inquireInvoiceStatus(ackId, authToken, creds);

    return c.json({ success: true, result: statusResult });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || err }, 500);
  } finally {
    await sql.end();
  }
});

// D. MANUAL ON-DEMAND SWEEPER (For Testing / Superadmin)
app.post('/api/eis/sweep-all', async (c) => {
  const authHeader = c.req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, message: 'Unauthorized.' }, 401);
  }

  const sql = createDbClient(c.env.HYPERDRIVE.connectionString);
  try {
    const result = await sweepAndTransmitAllActiveEisMerchants(sql);
    return c.json({ success: true, result });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  } finally {
    await sql.end();
  }
});

// -----------------------------------------------------------------------------
// 5. FUNCTION WHITELISTS & ROUTING
// -----------------------------------------------------------------------------
const PUBLIC_ANON_FUNCTIONS = new Set([
  'can_request_password_reset',
  'can_submit_new_password',
  'c_verify_password_reset_rate_limit',
  'c_get_marketplace_products',
  'pos2_get_public_kiosk_menu',                 // <-- Public Menu by QR Token
  'pos2_submit_unauthenticated_order_slip',
]);

const EXTRA_AUTH_FUNCTIONS = new Set([
  'validate_pos_account_password',
  'validate_pos_staff_user',
  'request_admin_persona_reset',
  'confirm_admin_persona_reset',
  'pos_can_manage',
  'pos_can_inventory',
  'pos_can_view_reports',
]);

const CACHEABLE_READ_PROCEDURES = new Set([
  // Products & Inventory
  'pos2_get_product_details',
  'pos2_get_all_products',
  'pos2_get_product_activity_by_id',
  'pos2_get_product_activity_history',
  'pos2_report_low_stock_products',
  'pos2_report_inventory_valuation',

  // Promotions
  'pos2_get_promotions',
  'pos2_get_promo_product_prices',

  // Customers & Debt
  'pos2_get_customers',
  'pos2_get_customers_simple',
  'pos2_search_customers',
  'pos2_get_customer_by_id',
  'pos2_get_customer_debt_details',
  'pos2_get_customer_financial_summary',
  'pos2_get_customer_installments',
  'pos2_get_all_installment_contracts',

  // Settings & Terminals
  'pos2_get_business_settings',
  'pos2_get_eis_settings',
  'pos2_get_terminals',
  'pos2_get_client_terminal_settings',
  'pos2_get_staff_accounts',

  // Sales History, Payments Audit & Statutory Ledgers
  'pos2_get_sales_history',
  'pos2_get_sale_details_by_id',
  'pos2_get_payments_list',
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

  // Installment Receipts
  'pos2_get_installment_payment_receipt',
  'pos2_get_installment_payments_by_order',

  // Marketplace & B2B CWT Invoices
  'c_get_business_settings',
  'c_get_marketplace_products',
  'c_get_subscription_invoice',
  'c_get_my_subscription_invoices',
  'c_get_my_cwt_invoices',
  'c_admin_get_cwt_reconciliation',

  // Support Tickets (Feedback CRUD)
  'c_get_feedback_threads',
  'c_get_feedback_thread_details',
]);

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
    procName.includes('eis_settings') ||
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
    procName.includes('audit') ||
    procName.includes('payment')
  ) {
    return 'reports';
  }
  if (
    procName.includes('marketplace') || 
    procName.includes('notification') || 
    procName.includes('subscription') || 
    procName.includes('feedback') ||
    procName.includes('cwt')
  ) {
    return 'marketplace';
  }
  return 'general';
}

// -----------------------------------------------------------------------------
// 6. RPC INTERCEPTOR (HYPERDRIVE CONNECTION POOL)
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

  // 1. Resolve User ID
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

  // 3. Connect to PostgreSQL via Hyperdrive
  const sql = createDbClient(c.env.HYPERDRIVE.connectionString);
  const isCacheable = CACHEABLE_READ_PROCEDURES.has(functionName);
  const argKeys = Object.keys(args);

  // Smart Type-Aware Argument Sanitizer:
  // - Preserves native PostgreSQL arrays ONLY when parameter expects bigint[] or text[]
  // - Serializes ALL JSONB payloads (p_cart_items, p_payments, p_attachments) as valid JSON strings
  const argValues = Object.entries(args).map(([key, val]) => {
    const isNativePgArrayParam = 
      key.includes('eligible_product_ids') || 
      key.endsWith('_array') || 
      (key.endsWith('_ids') && Array.isArray(val) && !key.includes('cart') && !key.includes('items'));

    if (isNativePgArrayParam) {
      if (Array.isArray(val)) {
        return val;
      }
      if (val === null || val === undefined || val === '' || val === '[]') {
        return [];
      }
      return val;
    }

    if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
      return val;
    }

    if (val !== null && typeof val === 'object') {
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
      // DIRECT TRANSACTIONAL PIPELINE (Mutations, Checkouts, Voids, Settlements)
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
// 7. REVERSE PROXY FOR SUPABASE AUTH & STORAGE
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

  // 1. If PostgreSQL named the column after the function itself (Scalars: boolean, text, or jsonb object)
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

// -----------------------------------------------------------------------------
// EXPORT BOTH FETCH (API) AND SCHEDULED (24/7 AUTOMATIC CRON SWEEPER)
// -----------------------------------------------------------------------------
export default {
  fetch: app.fetch,

  // Cloudflare runs this background hook automatically based on your wrangler.json schedule
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    console.log(`[EIS Cron Triggered]: Scheduled event fired at ${new Date().toISOString()}`);

    ctx.waitUntil((async () => {
      const sql = createDbClient(env.HYPERDRIVE.connectionString);
      try {
        const result = await sweepAndTransmitAllActiveEisMerchants(sql);
        console.log('[EIS Cron Sweep Result]:', JSON.stringify(result));
      } catch (err: any) {
        console.error('[Scheduled Cron EIS Background Sweep Error]:', err.message || err);
      } finally {
        await sql.end();
      }
    })());
  },
};
