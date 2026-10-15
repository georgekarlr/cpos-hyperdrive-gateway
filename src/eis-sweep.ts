import { 
  formatBirEisPayload, 
  signEisPayload, 
  getBirAuthToken, 
  transmitBatchToBir,
  EisCredentials 
} from './eis';

export interface SweepResultSummary {
  success: boolean;
  message: string;
  merchantsProcessed: number;
  totalInvoicesTransmitted: number;
  storesUpdated: Array<{
    userId: string;
    businessName: string;
    invoicesCount: number;
    batchAckId: string;
  }>;
  errors: Array<{
    userId: string;
    businessName: string;
    error: string;
  }>;
}

/**
 * Sweeps all active EIS merchants across the database,
 * batches their pending sales, and transmits them to BIR EIS.
 * Runs automatically every 5 minutes via Cloudflare Scheduled Events.
 */
export async function sweepAndTransmitAllActiveEisMerchants(sql: any): Promise<SweepResultSummary> {
  const summary: SweepResultSummary = {
    success: true,
    message: 'EIS auto-sweep completed.',
    merchantsProcessed: 0,
    totalInvoicesTransmitted: 0,
    storesUpdated: [],
    errors: [],
  };

  try {
    // 1. Discover all stores with active EIS credentials AND pending invoices
    const activeEisMerchants = await sql`
      SELECT DISTINCT 
        s.user_id, 
        s.client_id, 
        s.client_secret, 
        s.private_signing_key, 
        s.ptt_number, 
        s.environment,
        s.eis_mode,
        b.business_name, 
        b.tin, 
        b.address, 
        b.billing_type
      FROM public.pos2_eis_settings s
      JOIN public.pos2_orders o ON s.user_id = o.user_id
      LEFT JOIN public.pos2_business_settings b ON s.user_id = b.user_id
      WHERE s.is_active = TRUE
        AND s.eis_mode != 'disabled'
        AND s.client_id IS NOT NULL 
        AND s.private_signing_key IS NOT NULL
        AND o.eis_status = 'pending'
      LIMIT 20; -- Process up to 20 distinct stores per execution cycle
    `;

    if (!activeEisMerchants || activeEisMerchants.length === 0) {
      summary.message = 'No pending invoices found across active EIS merchants.';
      return summary;
    }

    // 2. Iterate through each store independently (Error Isolated)
    for (const merchant of activeEisMerchants) {
      const storeName = merchant.business_name || `Store (${merchant.user_id})`;

      try {
        // Fetch up to 100 oldest pending invoices for this store
        const pendingOrders = await sql`
          SELECT 
            o.*, 
            COALESCE(t.terminal_name, 'Register') AS terminal_name, 
            COALESCE(t.min, '01010-WEB') AS min, 
            COALESCE(t.ptu_number, merchant_settings.ptt_number, 'PTU-000000') AS ptu_number
          FROM public.pos2_orders o
          LEFT JOIN public.pos2_terminals t ON o.terminal_id = t.id
          LEFT JOIN (
            SELECT user_id, ptt_number FROM public.pos2_eis_settings WHERE user_id = ${merchant.user_id}
          ) merchant_settings ON o.user_id = merchant_settings.user_id
          WHERE o.user_id = ${merchant.user_id}
            AND o.eis_status = 'pending'
          ORDER BY COALESCE(o.occurred_at, o.created_at) ASC
          LIMIT 100;
        `;

        if (!pendingOrders || pendingOrders.length === 0) {
          continue;
        }

        const orderIds = pendingOrders.map((o: any) => o.id);

        // Bulk-fetch all line items for this batch in 1 single query
        const allItems = await sql`
          SELECT 
            oi.*, 
            p.name AS product_name, 
            COALESCE(p.item_type, 'goods') AS item_type
          FROM public.pos2_order_items oi
          JOIN public.pos2_products p ON oi.product_id = p.id
          WHERE oi.order_id = ANY(${orderIds});
        `;

        // Group line items by order_id
        const itemsByOrder: Record<number, any[]> = {};
        for (const item of allItems) {
          if (!itemsByOrder[item.order_id]) {
            itemsByOrder[item.order_id] = [];
          }
          itemsByOrder[item.order_id].push(item);
        }

        // Format each invoice into BIR Schema v2.01 and digitally sign as JWS in parallel
        const signedJwsList: string[] = await Promise.all(
          pendingOrders.map(async (order: any) => {
            const orderItems = itemsByOrder[order.id] || [];
            const payload = formatBirEisPayload(order, orderItems, merchant);
            return await signEisPayload(payload, merchant.private_signing_key);
          })
        );

        // Setup credentials for this merchant
        const creds: EisCredentials = {
          clientId: merchant.client_id,
          clientSecret: merchant.client_secret,
          privateSigningKey: merchant.private_signing_key,
          pttNumber: merchant.ptt_number,
          environment: (merchant.environment || 'sandbox') as 'sandbox' | 'production',
        };

        // Authenticate with BIR to get 6-hour Bearer token
        const authToken = await getBirAuthToken(creds);

        // Transmit entire batch of up to 100 invoices in a single HTTPS call
        const batchResponse = await transmitBatchToBir(signedJwsList, authToken, creds);
        const globalAckId = batchResponse.batchAckId 
          || batchResponse.ackId 
          || `BATCH-ACK-${Date.now()}`;

        // 3. Update Order Records in Database
        // If BIR returned per-invoice results, update each individually
        if (Array.isArray(batchResponse.results) && batchResponse.results.length > 0) {
          for (const res of batchResponse.results) {
            const targetOrder = pendingOrders.find((o: any) => o.invoice_number === res.invoiceNumber);
            if (targetOrder) {
              const isAccepted = res.status === 'ACCEPTED' || res.status === 'SUCCESS' || !res.errors;
              await sql`
                UPDATE public.pos2_orders
                SET 
                  eis_status = ${isAccepted ? 'transmitted' : 'rejected'},
                  eis_ack_id = ${res.ackId || globalAckId},
                  eis_transmitted_at = NOW(),
                  eis_error_log = ${res.errors ? JSON.stringify(res.errors) : null}
                WHERE id = ${targetOrder.id};
              `;
            }
          }
        } else {
          // Bulk-update all orders in this batch to 'transmitted'
          await sql`
            UPDATE public.pos2_orders
            SET 
              eis_status = 'transmitted',
              eis_ack_id = ${globalAckId},
              eis_transmitted_at = NOW(),
              eis_error_log = NULL
            WHERE id = ANY(${orderIds});
          `;
        }

        // Update last sync timestamp on merchant's EIS settings
        await sql`
          UPDATE public.pos2_eis_settings
          SET last_sync_at = NOW()
          WHERE user_id = ${merchant.user_id};
        `;

        summary.merchantsProcessed += 1;
        summary.totalInvoicesTransmitted += pendingOrders.length;
        summary.storesUpdated.push({
          userId: merchant.user_id,
          businessName: storeName,
          invoicesCount: pendingOrders.length,
          batchAckId: globalAckId,
        });

      } catch (merchantErr: any) {
        const errorMsg = merchantErr.message || String(merchantErr);
        console.error(`[EIS Auto-Sweep Failure for ${storeName}]:`, merchantErr);

        summary.errors.push({
          userId: merchant.user_id,
          businessName: storeName,
          error: errorMsg,
        });

        // Flag orders with the error details so accountants can review why transmission failed
        try {
          await sql`
            UPDATE public.pos2_orders
            SET 
              eis_error_log = ${errorMsg}
            WHERE user_id = ${merchant.user_id} 
              AND eis_status = 'pending';
          `;
        } catch (_) {}
      }
    }

    return summary;
  } catch (criticalErr: any) {
    console.error('[EIS Critical Sweep Crash]:', criticalErr);
    summary.success = false;
    summary.message = criticalErr.message || 'Fatal error during EIS sweep.';
    return summary;
  }
}
