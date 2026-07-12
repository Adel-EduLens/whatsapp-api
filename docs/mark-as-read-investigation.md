# Mark as Read on Reply - Investigation

## Goal

When sending a message (replying) to a user through the API, automatically mark their chat as read (clear the unread badge/count).

## What is a LID?

**LID (Linked Identity)** is WhatsApp's internal opaque identifier for accounts, introduced with multi-device support. Instead of using phone numbers as the primary ID, WhatsApp assigns each account a numeric LID.

- Phone-based JID: `201119915593@s.whatsapp.net` or `201119915593@c.us`
- LID-based JID: `169419766538483@lid`

Both refer to the **same** WhatsApp account but use completely different numeric identifiers. There is no mathematical relationship between the two numbers.

## The Core Problem: LID-to-Phone Mapping

### How it manifests

Baileys internally uses LID JIDs for all incoming messages. But API users send messages using phone numbers. This creates a mismatch:

| Step | JID Format | Source |
|------|-----------|--------|
| Incoming message arrives | `169419766538483@lid` | Baileys `messages.upsert` event |
| Store message key | `169419766538483@lid` | Our code stores the key |
| API sends reply to | `201119915593@c.us` | User's API request |
| `markAsRead` called with | `201119915593@c.us` | MessageService |
| Lookup stored key by | `201119915593@c.us` | Our code |
| **Result** | **NOT FOUND** | No mapping between LID and phone |

### Debug log evidence

```
sendTextMessage result.key: {"remoteJid":"201119915593@c.us","fromMe":true,"id":"3EB0794E8C12A5B09839CF"}
markAsRead debug: chatId=201119915593@c.us storedKeys=[169419766538483@lid, 169419766538483@c.us, 169419766538483@s.whatsapp.net]
No last incoming message found for chat 201119915593@c.us
```

The send result gives back `201119915593@c.us` (same phone-based JID we passed in), NOT the LID. The stored keys are all under `169419766538483` (the LID number). There is zero overlap.

### Why `lidToPhone` map is empty

Baileys is supposed to populate LID-to-phone mappings from contact events:
- `contacts.upsert` - fired when contacts are synced
- `messaging-history.set` - fired on initial history sync

However, these events do not fire reliably:
- On reconnection with saved credentials, full contact sync may be skipped
- Not all contacts trigger these events
- The mapping for specific contacts may never be received

### This also breaks OTP

The same problem affects the OTP module:

```
OTP: checking message from=169419766538483 normalized=+169419766538483
```

The OTP service receives the raw LID number (`169419766538483`) instead of the real phone number (`201119915593`), so it can never match against pending OTP requests that use the real phone number.

### Additional complication: Bad MAC errors

The logs show repeated `Bad MAC` errors when decrypting messages from `169419766538483@lid`:

```
Session error: Error: Bad MAC
    at Object.verifyMAC (libsignal/src/crypto.js:87:15)
```

This causes some incoming messages to arrive with `hasMessage=false` (body couldn't be decrypted). The messages still have valid keys (remoteJid + id) but no readable content.

## Approaches Tried

### Approach 1: Direct `markAsRead` call (failed)

Called `engine.markAsRead(chatId)` from `MessageService.completeMessageSending()` after each send.

**Why it failed:** `readMessages` requires a valid message key (`{ remoteJid, id, fromMe }`). Without a message ID, Baileys throws `Incomplete key`.

### Approach 2: Store incoming message keys (failed)

Tracked last incoming message keys per chat in a `Map<string, MessageKey>`, stored under multiple JID formats (`@lid`, `@c.us`, `@s.whatsapp.net`).

**Why it failed:** Keys were stored under LID-based formats (`169419766538483@lid`), but `markAsRead` was called with phone-based format (`201119915593@c.us`). No mapping exists between the two numbers.

### Approach 3: Capture LID from send result (failed)

Added `phoneToRemoteJid` map: after `sock.sendMessage()`, captured `result.key.remoteJid` to map phone number to actual JID.

**Why it failed:** `sock.sendMessage()` returns the same phone-based JID that was passed in (`201119915593@c.us`), not the LID. Baileys doesn't expose the LID in the send result.

### Approach 4: Use `messages.upsert type=append` (current)

When Baileys echoes back our sent message, the `type=append` event may contain the actual LID JID. We intercept this and call `readMessages` using stored incoming keys for that LID.

**Status:** Deployed, awaiting test results.

## Files Modified

- `src/engine/interfaces/whatsapp-engine.interface.ts` - Added `markAsRead` to `IWhatsAppEngine` interface
- `src/engine/adapters/baileys.adapter.ts` - Implemented `markAsRead` + append-based auto-read + message key tracking
- `src/engine/adapters/whatsapp-web-js.adapter.ts` - Implemented `markAsRead` using `chat.sendSeen()`
- `src/modules/message/message.service.ts` - Call `markAsRead` after every successful send

## Key Takeaway

The fundamental issue is that Baileys multi-device uses LID JIDs internally, but provides no reliable way to map between LID and phone number. This affects any feature that needs to correlate incoming messages (LID) with user-facing operations (phone number), including:

1. **Mark as read** - can't find the right chat to mark
2. **OTP verification** - can't match incoming code to pending request
3. **Any future feature** that needs to associate incoming messages with phone-number-based lookups
