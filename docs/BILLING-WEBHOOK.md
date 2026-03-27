# Billing Entitlement Webhook

Endpoint:

```text
POST /api/billing/webhook/entitlement
```

Auth:

- Header: `x-entitlement-secret`
- Value: `ENTITLEMENT_WEBHOOK_SECRET`

## Payload shape

```json
{
  "eventType": "subscription.updated",
  "customerId": "cus_123",
  "guildId": "123456789012345678",
  "plan": "growth",
  "status": "approved",
  "metadata": {
    "source": "stripe",
    "invoiceId": "in_123"
  }
}
```

## Event handling

- `approved` and `success` values apply the requested plan.
- `cancelled`, `canceled`, `past_due`, and `suspended` values set the tenant status to `suspended`.
- Duplicate payloads are idempotent through a payload hash stored in `billing_entitlement_events`.

Valid plan keys:

- `starter`
- `growth`
- `pro`
- `enterprise`

## Curl tests

Apply a plan:

```bash
curl -X POST http://localhost:3000/api/billing/webhook/entitlement \
  -H 'Content-Type: application/json' \
  -H "x-entitlement-secret: ${ENTITLEMENT_WEBHOOK_SECRET}" \
  -d '{
    "eventType": "subscription.updated",
    "customerId": "cus_123",
    "guildId": "123456789012345678",
    "plan": "pro",
    "status": "approved",
    "metadata": { "source": "stripe" }
  }'
```

Suspend a tenant:

```bash
curl -X POST http://localhost:3000/api/billing/webhook/entitlement \
  -H 'Content-Type: application/json' \
  -H "x-entitlement-secret: ${ENTITLEMENT_WEBHOOK_SECRET}" \
  -d '{
    "eventType": "invoice.payment_failed",
    "customerId": "cus_123",
    "guildId": "123456789012345678",
    "plan": "pro",
    "status": "past_due"
  }'
```

Duplicate payload check:

```bash
curl -X POST http://localhost:3000/api/billing/webhook/entitlement \
  -H 'Content-Type: application/json' \
  -H "x-entitlement-secret: ${ENTITLEMENT_WEBHOOK_SECRET}" \
  -d '{
    "eventType": "subscription.updated",
    "customerId": "cus_123",
    "guildId": "123456789012345678",
    "plan": "growth",
    "status": "success"
  }'
```

The second call with the same payload should return a duplicate success response.
