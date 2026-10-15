import { importPKCS8, CompactSign } from 'jose';

// ============================================================================
// 1. TYPES & INTERFACES
// ============================================================================

export interface EisCredentials {
  clientId: string;
  clientSecret: string;
  privateSigningKey: string;
  pttNumber: string;
  environment: 'sandbox' | 'production';
}

export interface BirEisDocumentDetails {
  documentType: string;
  invoiceNumber: string;
  issueDate: string;
  issueTime: string;
  currency: string;
  terminalMin: string;
  ptuNumber: string;
}

export interface BirEisPartyDetails {
  tin: string;
  branchCode: string;
  registeredName: string;
  address: string;
  isB2B?: boolean;
  purchaseOrderNumber?: string | null;
}

export interface BirEisLineItem {
  itemSeq: number;
  itemType: 'GOODS' | 'SERVICES';
  description: string;
  quantity: number;
  unitOfMeasure: string;
  unitPrice: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  taxClassification: string;
  vatAmount: number;
}

export interface BirEisSummaryDetails {
  grossTotal: number;
  totalDiscounts: number;
  vatExemptDiscount: number;
  vatableSales: number;
  vatAmount: number;
  vatExemptSales: number;
  zeroRatedSales: number;
  totalAmountDue: number;
  withholdingTax: {
    totalCwt: number;
    cwtGoods: number;
    cwtServices: number;
    form2307Ref: string | null;
  };
  surcharges: {
    serviceCharge: number;
    amusementTax: number;
    exciseTax: number;
    ecoTourismFee: number;
  };
}

export interface BirEisInvoiceSchema {
  documentDetails: BirEisDocumentDetails;
  sellerDetails: BirEisPartyDetails;
  buyerDetails: BirEisPartyDetails;
  lineItems: BirEisLineItem[];
  summaryDetails: BirEisSummaryDetails;
}

export interface BirTransmissionResult {
  status: string;
  ackId: string;
  rawResponse: any;
}

export interface BirBatchTransmissionResult {
  status: string;
  batchAckId: string;
  totalSubmitted: number;
  results: Array<{
    invoiceNumber: string;
    status: string;
    ackId: string;
    errors?: any[];
  }>;
  rawResponse: any;
}

// ============================================================================
// 2. BIR EIS SCHEMA SERIALIZER (v2.01)
// ============================================================================

/**
 * Transforms pos2_orders, pos2_order_items, and store settings
 * into the official BIR EIS JSON Schema v2.01.
 */
export function formatBirEisPayload(
  order: any, 
  items: any[], 
  settings: any
): BirEisInvoiceSchema {
  const isVat = settings?.billing_type === 'VAT';

  // Format Seller TIN (9-digit base TIN + 3-5 digit Branch Code)
  const rawSellerTin = (settings?.tin || '000-000-000-00000').replace(/[^0-9-]/g, '');
  const sellerBaseTin = rawSellerTin.replace(/-/g, '').slice(0, 9);
  const sellerBranchCode = rawSellerTin.includes('-')
    ? rawSellerTin.split('-')[3] || '00000'
    : '00000';

  // Format Buyer TIN (for B2B commercial entities or individual consumers)
  const rawBuyerTin = (order.b2b_tin || order.customer_id_reference || '').replace(/[^0-9-]/g, '');
  const buyerBaseTin = rawBuyerTin.length >= 9 ? rawBuyerTin.replace(/-/g, '').slice(0, 9) : '000000000';
  const buyerBranchCode = rawBuyerTin.includes('-')
    ? rawBuyerTin.split('-')[3] || '00000'
    : '00000';

  const transactionTimestamp = order.occurred_at || order.created_at || new Date().toISOString();
  const [issueDate, rawTime] = transactionTimestamp.includes('T')
    ? transactionTimestamp.split('T')
    : transactionTimestamp.split(' ');
  const issueTime = (rawTime || '00:00:00').slice(0, 8);

  return {
    documentDetails: {
      documentType: '380', // Commercial Sales Invoice (Standard UN/EDIFACT code used by BIR)
      invoiceNumber: order.invoice_number,
      issueDate: issueDate,
      issueTime: issueTime,
      currency: 'PHP',
      terminalMin: order.min || '01010-WEB',
      ptuNumber: order.ptu_number || 'PTU-000000',
    },
    sellerDetails: {
      tin: sellerBaseTin,
      branchCode: sellerBranchCode,
      registeredName: settings?.business_name || 'My Business Name',
      address: settings?.address || 'Philippines',
    },
    buyerDetails: {
      isB2B: !!order.b2b_company_name,
      tin: buyerBaseTin,
      branchCode: buyerBranchCode,
      registeredName: order.b2b_company_name || order.customer_name || 'Retail Customer',
      address: order.b2b_address || order.customer_address || 'Philippines',
      purchaseOrderNumber: order.b2b_po_number || null,
    },
    lineItems: items.map((item, index) => {
      const isGood = (item.item_type || 'goods') === 'goods';
      const quantity = parseFloat(item.quantity || 1);
      const basePrice = parseFloat(item.base_price_at_purchase || 0);
      const grossAmount = parseFloat((basePrice * quantity).toFixed(2));
      const specialDiscount = parseFloat(item.special_discount_amount || 0);
      const promoDiscount = parseFloat(item.promo_discount_amount || 0);
      const totalItemDiscount = parseFloat((specialDiscount + promoDiscount).toFixed(2));
      const netAmount = parseFloat((grossAmount - totalItemDiscount).toFixed(2));

      let taxClassification = item.tax_type_at_purchase || (isVat ? 'VATable' : 'VAT-Exempt');
      if (!isVat) {
        taxClassification = 'VAT-Exempt';
      }

      let lineVatAmount = 0.00;
      if (isVat && taxClassification === 'VATable') {
        const taxRate = parseFloat(item.tax_rate_at_purchase || 12.00);
        lineVatAmount = parseFloat((netAmount * (taxRate / 100)).toFixed(2));
      }

      return {
        itemSeq: index + 1,
        itemType: isGood ? 'GOODS' : 'SERVICES',
        description: item.product_name,
        quantity: quantity,
        unitOfMeasure: item.unit_type_at_purchase || (isGood ? 'pcs' : 'unit'),
        unitPrice: basePrice,
        grossAmount: grossAmount,
        discountAmount: totalItemDiscount,
        netAmount: netAmount,
        taxClassification: taxClassification,
        vatAmount: lineVatAmount,
      };
    }),
    summaryDetails: {
      grossTotal: parseFloat(parseFloat(order.subtotal_amount || 0).toFixed(2)),
      totalDiscounts: parseFloat(
        (parseFloat(order.special_discount_amount || 0) + parseFloat(order.promo_discount_total || 0)).toFixed(2)
      ),
      vatExemptDiscount: parseFloat(parseFloat(order.vat_exempt_discount_amount || 0).toFixed(2)),
      vatableSales: isVat ? parseFloat(parseFloat(order.vatable_sales || 0).toFixed(2)) : 0.00,
      vatAmount: isVat ? parseFloat(parseFloat(order.tax_amount || 0).toFixed(2)) : 0.00,
      vatExemptSales: !isVat 
        ? parseFloat(parseFloat(order.total_amount || 0).toFixed(2))
        : parseFloat(parseFloat(order.vat_exempt_sales || 0).toFixed(2)),
      zeroRatedSales: 0.00,
      totalAmountDue: parseFloat(parseFloat(order.total_amount || 0).toFixed(2)),
      withholdingTax: {
        totalCwt: parseFloat(parseFloat(order.withholding_tax_amount || 0).toFixed(2)),
        cwtGoods: parseFloat(parseFloat(order.cwt_goods_amount || 0).toFixed(2)),       // 1% Goods (ATC WC 158)
        cwtServices: parseFloat(parseFloat(order.cwt_services_amount || 0).toFixed(2)), // 2% Services (ATC WC 160)
        form2307Ref: order.bir_form_2307_ref || null,
      },
      surcharges: {
        serviceCharge: parseFloat(parseFloat(order.service_charge_amount || 0).toFixed(2)),
        amusementTax: parseFloat(parseFloat(order.amusement_tax_amount || 0).toFixed(2)),
        exciseTax: parseFloat(parseFloat(order.excise_tax_amount || 0).toFixed(2)),
        ecoTourismFee: parseFloat(parseFloat(order.eco_tourism_fee_amount || 0).toFixed(2)),
      },
    },
  };
}

// ============================================================================
// 3. CRYPTOGRAPHIC DIGITAL SIGNATURE (JWS COMPACT SERIALIZATION)
// ============================================================================

/**
 * Digitally signs the BIR EIS JSON payload using the Taxpayer's Private Key (RS256).
 * Produces a standard Compact JWS string: `header.payload.signature`
 */
export async function signEisPayload(payload: any, privateKeyPem: string): Promise<string> {
  if (!privateKeyPem || !privateKeyPem.includes('PRIVATE KEY')) {
    throw new Error('Invalid Taxpayer Private Signing Key. Valid PKCS8 PEM format is required.');
  }

  // Clean and import private key
  const cleanedKey = privateKeyPem
    .replace(/\\n/g, '\n')
    .trim();

  const privateKey = await importPKCS8(cleanedKey, 'RS256');

  // Convert payload to bytes
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(JSON.stringify(payload));

  // Build Compact JWS signature
  const jws = await new CompactSign(payloadBytes)
    .setProtectedHeader({
      alg: 'RS256',
      typ: 'JWT',
    })
    .sign(privateKey);

  return jws;
}

// ============================================================================
// 4. BIR EIS AUTHENTICATION CLIENT (6-HOUR TOKEN EXCHANGE)
// ============================================================================

/**
 * Authenticates with BIR EIS Gateway to acquire the 6-hour Bearer token.
 */
export async function getBirAuthToken(creds: EisCredentials): Promise<string> {
  const baseUrl = creds.environment === 'production'
    ? 'https://eis.bir.gov.ph'
    : 'https://eis-cert.bir.gov.ph';

  const response = await fetch(`${baseUrl}/api/v1/auth`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`BIR EIS Authentication Failed (HTTP ${response.status}): ${errorBody}`);
  }

  const data: any = await response.json();
  const token = data.access_token || data.token;

  if (!token) {
    throw new Error(`BIR EIS Authentication Response missing access token: ${JSON.stringify(data)}`);
  }

  return token;
}

// ============================================================================
// 5. SINGLE INVOICE TRANSMISSION
// ============================================================================

/**
 * Transmits a single JWS-signed invoice to the BIR EIS server.
 */
export async function transmitInvoiceToBir(
  jwsSignedPayload: string, 
  authToken: string, 
  creds: EisCredentials
): Promise<BirTransmissionResult> {
  const baseUrl = creds.environment === 'production'
    ? 'https://eis.bir.gov.ph'
    : 'https://eis-cert.bir.gov.ph';

  const response = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      invoices: [jwsSignedPayload],
    }),
  });

  const responseBody: any = await response.json();

  if (!response.ok) {
    throw new Error(`BIR Single Invoice Transmission Rejected (HTTP ${response.status}): ${JSON.stringify(responseBody)}`);
  }

  const ackId = responseBody.ackId 
    || responseBody.acknowledgementId 
    || (responseBody.results && responseBody.results[0]?.ackId) 
    || `ACK-${Date.now()}`;

  return {
    status: responseBody.status || 'SUCCESS',
    ackId: ackId,
    rawResponse: responseBody,
  };
}

// ============================================================================
// 6. BATCH TRANSMISSION (UP TO 100 INVOICES PER CALL)
// ============================================================================

/**
 * Submits an array of 1 to 100 JWS-signed invoices in a single HTTP POST request.
 */
export async function transmitBatchToBir(
  jwsInvoices: string[], 
  authToken: string, 
  creds: EisCredentials
): Promise<BirBatchTransmissionResult> {
  if (!jwsInvoices || jwsInvoices.length === 0) {
    throw new Error('Batch submission error: Invoice list is empty.');
  }

  if (jwsInvoices.length > 100) {
    throw new Error('BIR EIS API limit violation: Maximum of 100 invoices per batch request.');
  }

  const baseUrl = creds.environment === 'production'
    ? 'https://eis.bir.gov.ph'
    : 'https://eis-cert.bir.gov.ph';

  const response = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      invoices: jwsInvoices,
    }),
  });

  const responseBody: any = await response.json();

  if (!response.ok) {
    throw new Error(`BIR Batch Transmission Rejected (HTTP ${response.status}): ${JSON.stringify(responseBody)}`);
  }

  const batchAckId = responseBody.batchAckId 
    || responseBody.ackId 
    || responseBody.acknowledgementId 
    || `BATCH-ACK-${Date.now()}`;

  const results = Array.isArray(responseBody.results) 
    ? responseBody.results 
    : [];

  return {
    status: responseBody.status || 'SUCCESS',
    batchAckId: batchAckId,
    totalSubmitted: jwsInvoices.length,
    results: results,
    rawResponse: responseBody,
  };
}

// ============================================================================
// 7. INVOICE STATUS INQUIRY
// ============================================================================

/**
 * Queries the official status and verification record of an invoice from BIR EIS using its ackId.
 */
export async function inquireInvoiceStatus(
  ackId: string, 
  authToken: string, 
  creds: EisCredentials
) {
  if (!ackId) {
    throw new Error('Acknowledgement ID (ackId) is required for status inquiry.');
  }

  const baseUrl = creds.environment === 'production'
    ? 'https://eis.bir.gov.ph'
    : 'https://eis-cert.bir.gov.ph';

  const response = await fetch(`${baseUrl}/api/v1/invoices/status/${encodeURIComponent(ackId)}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Accept': 'application/json',
    },
  });

  const responseBody: any = await response.json();

  if (!response.ok) {
    throw new Error(`BIR Status Inquiry Failed (HTTP ${response.status}): ${JSON.stringify(responseBody)}`);
  }

  return responseBody;
}
