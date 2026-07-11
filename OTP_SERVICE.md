# OTP Verification Service — Setup Guide

## Overview

Your project acts as a WhatsApp OTP verification service. Websites call your API to verify that a user owns a phone number. The user proves it by sending an OTP code to your WhatsApp number.

---

## Flow

```
Website                    Your API                  User
  |                           |                        |
  |-- POST /otp ------------->|                        |
  |   (phone, code, callback) |                        |
  |                           |                        |
  |<-- { whatsappLink } ------|                        |
  |                           |                        |
  |-- Show button to user --->|                        |
  |   "Verify via WhatsApp"   |                        |
  |   wa.me/NUMBER?text=CODE  |                        |
  |                           |                        |
  |                           |<-- User sends code ----|
  |                           |    (WhatsApp message)   |
  |                           |                        |
  |                           |-- Match phone + code    |
  |                           |                        |
  |<-- POST callbackUrl ------|                        |
  |    { phone, verified }    |                        |
```

---

## What Needs to Be Built

### 1. OTP Module

A new NestJS module (`src/modules/otp/`) with:

- **OTP Entity** — stores pending verifications in the database
  - `id` — UUID
  - `phone` — phone number to verify
  - `code` — the OTP code
  - `sessionId` — which WhatsApp session to receive on
  - `callbackUrl` — URL to notify when verified
  - `callbackSecret` — optional HMAC secret for signing the callback
  - `status` — `pending` | `verified` | `expired`
  - `expiresAt` — expiry timestamp
  - `createdAt` — creation timestamp

- **OTP Controller** — API endpoints
  - `POST /otp` — register a new OTP verification
  - `GET /otp/:id` — check status of a verification
  - `DELETE /otp/:id` — cancel a pending verification

- **OTP Service** — business logic
  - Save pending OTP to database
  - Match incoming messages against pending OTPs (phone + code)
  - Call the website's callback URL on match
  - Auto-expire old OTPs

### 2. Message Listener

Hook into the existing incoming message handler (`session.service.ts`):

- When a message is received, check if the sender's phone number has a pending OTP
- If the message body matches the expected code → mark as verified → call callback
- If no match → ignore (normal message)

### 3. API Endpoints

#### Register OTP

```
POST /otp
Content-Type: application/json

{
  "phone": "+123456789",
  "code": "4821",
  "sessionId": "main",              // which session receives the message
  "callbackUrl": "https://website.com/verify",
  "callbackSecret": "optional-hmac-secret",
  "expiresIn": 120                  // seconds, default 120
}
```

**Response:**

```json
{
  "id": "uuid",
  "phone": "+123456789",
  "status": "pending",
  "expiresAt": "2026-07-09T12:02:00Z",
  "whatsappLink": "https://wa.me/YOUR_NUMBER?text=4821"
}
```

The website uses `whatsappLink` to show the user a "Verify" button.

#### Check Status

```
GET /otp/:id
```

**Response:**

```json
{
  "id": "uuid",
  "phone": "+123456789",
  "status": "verified",
  "verifiedAt": "2026-07-09T12:01:30Z"
}
```

#### Cancel OTP

```
DELETE /otp/:id
```

### 4. Callback to Website

When OTP is verified, your system calls:

```
POST https://website.com/verify
Content-Type: application/json
X-OTP-Signature: hmac-sha256-signature (if secret provided)

{
  "id": "uuid",
  "phone": "+123456789",
  "verified": true,
  "verifiedAt": "2026-07-09T12:01:30Z"
}
```

### 5. Expiry Cleanup

- A cron job or scheduled task that runs every 60 seconds
- Marks all OTPs past their `expiresAt` as `expired`
- Optionally sends a callback with `{ verified: false, reason: "expired" }`

---

## WhatsApp Sessions Needed

| Session | Purpose |
| --- | --- |
| 1 (primary) | Receives all OTP messages |
| 2 (backup) | Failover if primary gets banned |

**No proxies needed** — you're only receiving messages, and WhatsApp doesn't rate-limit incoming messages.

---

## Security Considerations

- **HMAC signatures** on callbacks so websites can verify the request came from you
- **Rate limiting** — limit OTP requests per phone number (e.g., max 5 per hour)
- **Code format** — enforce numeric codes, 4-6 digits
- **One active OTP per phone** — new request cancels the previous one
- **API key per client** — each website gets its own API key to use your service
- **Phone number validation** — validate format before accepting

---

## Client Integration Example

Website backend:

```javascript
// 1. Request OTP verification
const response = await fetch('https://your-api.com/otp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer CLIENT_API_KEY'
  },
  body: JSON.stringify({
    phone: '+123456789',
    code: '4821',
    callbackUrl: 'https://my-website.com/api/whatsapp-verify',
    expiresIn: 120
  })
});

const { whatsappLink } = await response.json();
// 2. Show whatsappLink as a button to the user
```

Website frontend:

```html
<a href="https://wa.me/NUMBER?text=4821" target="_blank">
  Verify via WhatsApp
</a>
```

Website callback handler:

```javascript
// 3. Receive verification result
app.post('/api/whatsapp-verify', (req, res) => {
  const { phone, verified } = req.body;
  if (verified) {
    // Mark user as verified in your database
  }
  res.sendStatus(200);
});
```

---

## Bonus: WebSocket + Callback + Polling (Triple Delivery)

For maximum reliability across different VPS/servers, support all three notification methods. The website uses whichever suits them best — or all three for redundancy.

### Why all three?

| Method | Pros | Cons |
| --- | --- | --- |
| **WebSocket** | Instant, no public endpoint needed | Connection can drop |
| **Callback URL** | Reliable, works server-to-server | Website needs a public endpoint |
| **GET /otp/:id** | Always works, simplest | Not real-time, requires polling |

### WebSocket Flow

1. Website connects to `wss://your-api.com/otp/ws?apiKey=CLIENT_API_KEY`
2. Website sends a subscribe message:
   ```json
   { "action": "subscribe", "otpId": "uuid" }
   ```
3. When OTP is verified, your system pushes:
   ```json
   { "event": "otp.verified", "id": "uuid", "phone": "+123456789", "verified": true }
   ```
4. If OTP expires:
   ```json
   { "event": "otp.expired", "id": "uuid", "phone": "+123456789", "verified": false }
   ```

### Delivery Priority

When an OTP is verified, your system tries all configured methods:

1. **WebSocket** — push instantly if the client is connected
2. **Callback URL** — POST to the URL (with retry: 3 attempts, exponential backoff)
3. **GET /otp/:id** — always available as fallback, no action needed

### Client Integration Example (WebSocket)

```javascript
const ws = new WebSocket('wss://your-api.com/otp/ws?apiKey=CLIENT_API_KEY');

ws.onopen = () => {
  ws.send(JSON.stringify({ action: 'subscribe', otpId: 'uuid' }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.event === 'otp.verified') {
    // Mark user as verified
  }
};

// Fallback: poll every 5s in case WebSocket drops
const poll = setInterval(async () => {
  const res = await fetch('https://your-api.com/otp/uuid');
  const data = await res.json();
  if (data.status === 'verified') {
    clearInterval(poll);
    // Mark user as verified
  }
}, 5000);
```

### Callback Retry Logic

If the callback URL fails:

| Attempt | Delay |
| --- | --- |
| 1st retry | 5 seconds |
| 2nd retry | 15 seconds |
| 3rd retry | 45 seconds |

After 3 failures, mark callback as `failed`. The website can still check via `GET /otp/:id` or WebSocket.
