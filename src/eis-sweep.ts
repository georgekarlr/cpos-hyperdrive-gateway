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
    // 1. Correctly join st_user_access for billing_type (VAT vs NON-VAT)
    const activeEisMerchants = await sql`
      SELECT DISTINCT 
        s.user_id, 
        s.client_id, 
        s.client_secret, 
        s.private_signing_key, 
        s.ptt_number, 
        s.environment,
        s.eis_mode,
        COALESCE(b.business_name, 'My Business Name') AS business_name, 
        COALESCE(b.tin, '000-000-000-00000') AS tin, 
        COALESCE(b.address, 'Philippines') AS address, 
        COALESCE(sua.billing_type, 'NON-VAT') AS billing_type
      FROM public.pos2_eis_settings s
      JOIN public.pos2_orders o ON s.user_id = o.user_id
      LEFT JOIN public.pos2_business_settings b ON s.user_id = b.user_id
      LEFT JOIN public.st_user_access sua ON s.user_id = sua.user_id
      WHERE s.is_active = TRUE
        AND s.eis_mode != 'disabled'
        AND s.client_id IS NOT NULL 
        AND s.private_signing_key IS NOT NULL
        AND o.eis_status = 'pending'
      LIMIT 20;
    `;

    if (!activeEisMerchants || activeEisMerchants.length === 0) {
      summary.message = 'No pending invoices found across active EIS merchants.';
      return summary;
    }

    // 2. Process each store's pending batch
    for (const merchant of activeEisMerchants) {
      const storeName = merchant.business_name || `Store (${merchant.user_id})`;

      try {
        const pendingOrders = await sql`
          SELECT 
            o.*, 
            COALESCE(t.terminal_name, 'Register') AS terminal_name, 
            COALESCE(t.min, '01010-WEB') AS min, 
            COALESCE(t.ptu_number, ${merchant.ptt_number}, 'PTU-000000') AS ptu_number
          FROM public.pos2_orders o
          LEFT JOIN public.pos2_terminals t ON o.terminal_id = t.id
          WHERE o.user_id = ${merchant.user_id}
            AND o.eis_status = 'pending'
          ORDER BY COALESCE(o.occurred_at, o.created_at) ASC
          LIMIT 100;
        `;

        if (!pendingOrders || pendingOrders.length === 0) {
          continue;
        }

        const orderIds = pendingOrders.map((o: any) => o.id);

        // Bulk-fetch line items
        const allItems = await sql`
          SELECT 
            oi.*, 
            p.name AS product_name, 
            COALESCE(p.item_type, 'goods') AS item_type
          FROM public.pos2_order_items oi
          JOIN public.pos2_products p ON oi.product_id = p.id
          WHERE oi.order_id = ANY(${orderIds});
        `;

        const itemsByOrder: Record<number, any[]> = {};
        for (const item of allItems) {
          if (!itemsByOrder[item.order_id]) {
            itemsByOrder[item.order_id] = [];
          }
          itemsByOrder[item.order_id].push(item);
        }

        // Format and sign JWS in parallel
        const signedJwsList: string[] = await Promise.all(
          pendingOrders.map(async (order: any) => {
            const orderItems = itemsByOrder[order.id] || [];
            const payload = formatBirEisPayload(order, orderItems, merchant);
            return await signEisPayload(payload, merchant.private_signing_key);
          })
        );

        const creds: EisCredentials = {
          clientId: merchant.client_id,
          clientSecret: merchant.client_secret,
          privateSigningKey: merchant.private_signing_key,
          pttNumber: merchant.ptt_number,
          environment: (merchant.environment || 'sandbox') as 'sandbox' | 'production',
        };

        const authToken = await getBirAuthToken(creds);
        const batchResponse = await transmitBatchToBir(signedJwsList, authToken, creds);
        
        const globalAckId = batchResponse.batchAckId 
          || batchResponse.ackId 
          || `BATCH-ACK-${Date.now()}`;

        // 3. Update orders
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
        console.error(`[EIS Auto-Sweep Failure for ${storeName}]:`, errorMsg);

        summary.errors.push({
          userId: merchant.user_id,
          businessName: storeName,
          error: errorMsg,
        });

        try {
          await sql`
            UPDATE public.pos2_orders
            SET eis_error_log = ${errorMsg}
            WHERE user_id = ${merchant.user_id} 
              AND eis_status = 'pending';
          `;
        } catch (_) {}
      }
    }

    return summary;
  } catch (criticalErr: any) {
    const errorDetails = criticalErr.message || String(criticalErr);
    console.error('[EIS Critical Sweep Crash]:', errorDetails);
    summary.success = false;
    summary.message = errorDetails;
    return summary;
  }
}
