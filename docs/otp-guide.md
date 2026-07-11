# OTP Verification Service — Usage Guide

## What Is This?

The OTP module lets websites verify that a user owns a phone number via WhatsApp. The website registers an OTP code through your API, the user sends that code to your WhatsApp number, and your system confirms the match.

**Your system does NOT generate or send the OTP.** The website decides the code and tells your API what to expect. Your system only listens for incoming WhatsApp messages and matches them.

## How It Works

```
Website                    Your API (OpenWA)         User
  |                           |                        |
  |-- POST /api/otp --------->|                        |
  |   { phone, code, ... }    |                        |
  |                           |                        |
  |<-- { whatsappLink } ------|                        |
  |                           |                        |
  |-- Show link to user ----->|                        |
  |   "Verify via WhatsApp"   |                        |
  |                           |                        |
  |                           |<-- User sends code ----|
  |                           |    via WhatsApp         |
  |                           |                        |
  |<-- POST callbackUrl ------|  (phone + code match)  |
  |    { verified: true }     |                        |
```

1. Website calls `POST /api/otp` with the phone number, a code, and a session name
2. API returns a `whatsappLink` (`wa.me/...?text=CODE`)
3. Website shows that link to the user as a "Verify via WhatsApp" button
4. User clicks the link, which opens WhatsApp with the code pre-filled, and sends it
5. Your system receives the message, matches phone + code, and marks the OTP as verified
6. Website gets notified via callback URL, WebSocket, or polling

## Prerequisites

- At least one WhatsApp session created and in `ready` status
- The session must be connected (has a phone number)

## API Endpoints

All endpoints require an API key via `X-API-Key` header or `Authorization: Bearer <key>`.

### Register OTP

```
POST /api/otp
Content-Type: application/json
X-API-Key: your-api-key
```

**Request body:**

| Field            | Type   | Required | Description                                    |
|------------------|--------|----------|------------------------------------------------|
| `phone`          | string | Yes      | Phone number in E.164 format (e.g. `+628123456789`) |
| `code`           | string | Yes      | 4-6 digit numeric code                         |
| `sessionId`      | string | Yes      | Session **name** (not UUID) to receive messages on |
| `callbackUrl`    | string | No       | URL to POST verification result to             |
| `callbackSecret` | string | No       | HMAC-SHA256 secret for signing the callback    |
| `expiresIn`      | number | No       | Seconds until expiry (30-600, default: 120)    |

**Example:**

```json
{
  "phone": "+628123456789",
  "code": "4821",
  "sessionId": "main",
  "callbackUrl": "https://my-website.com/api/verify",
  "callbackSecret": "my-hmac-secret",
  "expiresIn": 120
}
```

**Response (201):**

```json
{
  "id": "a1b2c3d4-...",
  "phone": "+628123456789",
  "status": "pending",
  "expiresAt": "2026-07-11T12:02:00.000Z",
  "whatsappLink": "https://wa.me/628100000000?text=4821",
  "createdAt": "2026-07-11T12:00:00.000Z"
}
```

The `whatsappLink` uses the **session's** WhatsApp number (the number your session is logged in as), not the user's number.

### Check OTP Status

```
GET /api/otp/:id
X-API-Key: your-api-key
```

**Response (200):**

```json
{
  "id": "a1b2c3d4-...",
  "phone": "+628123456789",
  "status": "verified",
  "expiresAt": "2026-07-11T12:02:00.000Z",
  "verifiedAt": "2026-07-11T12:01:30.000Z",
  "createdAt": "2026-07-11T12:00:00.000Z"
}
```

Possible `status` values: `pending`, `verified`, `expired`, `cancelled`

### Cancel OTP

```
DELETE /api/otp/:id
X-API-Key: your-api-key
```

Returns `204 No Content` on success. Only works on `pending` OTPs.

## Getting Notified

Three ways to know when an OTP is verified (use whichever suits you):

### 1. Callback URL (recommended for server-to-server)

If you provided a `callbackUrl`, your system POSTs to it on verification or expiry:

```
POST https://my-website.com/api/verify
Content-Type: application/json
X-OTP-Signature: sha256=abc123...   (if callbackSecret was provided)

{
  "id": "a1b2c3d4-...",
  "phone": "+628123456789",
  "verified": true,
  "verifiedAt": "2026-07-11T12:01:30.000Z"
}
```

On expiry:

```json
{
  "id": "a1b2c3d4-...",
  "phone": "+628123456789",
  "verified": false,
  "reason": "expired"
}
```

**Retry logic:** If the callback fails, retries up to 3 more times with delays of 5s, 15s, 45s.

**Verifying the signature** (if `callbackSecret` was provided):

```javascript
const crypto = require('crypto');

function verifySignature(body, secret, signatureHeader) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body); // raw request body string
  const expected = `sha256=${hmac.digest('hex')}`;
  return expected === signatureHeader;
}
```

### 2. WebSocket (real-time)

Connect to the WebSocket and subscribe to OTP events:

```javascript
const ws = io('http://your-api:2785/events', {
  extraHeaders: { 'x-api-key': 'your-api-key' }
});

ws.on('connect', () => {
  ws.emit('message', {
    type: 'subscribe',
    sessionId: '*',
    events: ['otp.verified', 'otp.expired']
  });
});

ws.on('message', (msg) => {
  if (msg.type === 'event') {
    const { event, data } = msg.payload;
    if (event === 'otp.verified') {
      console.log('Verified:', data.phone);
    }
    if (event === 'otp.expired') {
      console.log('Expired:', data.phone);
    }
  }
});
```

### 3. Polling (simplest)

Poll `GET /api/otp/:id` every few seconds and check the `status` field:

```javascript
const poll = setInterval(async () => {
  const res = await fetch('http://your-api:2785/api/otp/OTP_ID', {
    headers: { 'X-API-Key': 'your-api-key' }
  });
  const data = await res.json();
  if (data.status === 'verified') {
    clearInterval(poll);
    // done
  } else if (data.status === 'expired' || data.status === 'cancelled') {
    clearInterval(poll);
    // failed
  }
}, 5000);
```

## Full Client Integration Example

### Website Backend (Node.js)

```javascript
const API_URL = 'http://your-api:2785/api';
const API_KEY = 'your-api-key';

// 1. User clicks "Verify my phone" — your backend creates the OTP
app.post('/start-verification', async (req, res) => {
  const { phone } = req.body;
  const code = String(Math.floor(1000 + Math.random() * 9000)); // random 4-digit code

  const response = await fetch(`${API_URL}/otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({
      phone,
      code,
      sessionId: 'main',
      callbackUrl: 'https://my-website.com/api/otp-callback',
      callbackSecret: 'my-secret',
      expiresIn: 120,
    }),
  });

  const data = await response.json();

  // Return the whatsapp link to the frontend
  res.json({
    otpId: data.id,
    whatsappLink: data.whatsappLink,
    expiresAt: data.expiresAt,
  });
});

// 2. Receive the callback when user verifies
app.post('/api/otp-callback', (req, res) => {
  // Verify HMAC signature
  const signature = req.headers['x-otp-signature'];
  // ... verify signature ...

  const { phone, verified } = req.body;
  if (verified) {
    // Mark this phone as verified in your database
  }
  res.sendStatus(200);
});
```

### Website Frontend

```html
<!-- Show this after calling /start-verification -->
<a id="verify-btn" href="" target="_blank"
   style="background: #25D366; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none;">
  Verify via WhatsApp
</a>

<script>
  // Set the href from the API response
  document.getElementById('verify-btn').href = whatsappLink;
</script>
```

## Behavior Notes

- **One OTP per phone per session** — creating a new OTP for the same phone + session auto-cancels the previous pending one
- **Only direct messages** — group messages are ignored for OTP matching
- **Exact match** — the entire message body must match the code exactly (after trimming whitespace)
- **Expiry cleanup** — a background job runs every 60 seconds to expire old OTPs
- **Phone format** — must be E.164 (`+` followed by country code and number, 7-15 digits)

## Error Responses

| Status | Meaning |
|--------|---------|
| 400    | Invalid input (bad phone format, code not 4-6 digits, session not connected) |
| 401    | Missing or invalid API key |
| 404    | Session name not found, or OTP ID not found |
